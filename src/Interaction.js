const InteractEvent = require('./InteractEvent');
const utils         = require('./utils');

class Interaction {
  /** */
  constructor ({ pointerType, signals }) {
    this._signals = signals;

    this.target   = null; // current interactable being interacted with
    this.element  = null; // the target element of the interactable
    this.prepared = {     // action that's ready to be fired on next move event
      name : null,
      axis : null,
      edges: null,
    };

    // keep track of added pointers
    this.pointers    = [];
    this.pointerIds  = [];
    this.downTargets = [];
    this.downTimes   = [];

    // Previous native pointer move event coordinates
    this.prevCoords = {
      page     : { x: 0, y: 0 },
      client   : { x: 0, y: 0 },
      timeStamp: 0,
    };
    // current native pointer move event coordinates
    this.curCoords = {
      page     : { x: 0, y: 0 },
      client   : { x: 0, y: 0 },
      timeStamp: 0,
    };

    // Starting InteractEvent pointer coordinates
    this.startCoords = {
      page     : { x: 0, y: 0 },
      client   : { x: 0, y: 0 },
      timeStamp: 0,
    };

    // Change in coordinates and time of the pointer
    this.pointerDelta = {
      page     : { x: 0, y: 0, vx: 0, vy: 0, speed: 0 },
      client   : { x: 0, y: 0, vx: 0, vy: 0, speed: 0 },
      timeStamp: 0,
    };

    this.downEvent   = null;    // pointerdown/mousedown/touchstart event
    this.downPointer = {};

    this._eventTarget    = null;
    this._curEventTarget = null;

    this.prevEvent = null;      // previous action event

    this.pointerIsDown   = false;
    this.pointerWasMoved = false;
    this._interacting    = false;
    this._ending         = false;

    this.pointerType = pointerType;

    this._signals.fire('new', this);
  }

  pointerDown (pointer, event, eventTarget) {
    const pointerIndex = this.updatePointer(pointer, event, eventTarget, true);

    this._signals.fire('down', {
      pointer,
      event,
      eventTarget,
      pointerIndex,
      interaction: this,
    });
  }

  /**
   * ```js
   * interact(target)
   *   .draggable({
   *     // disable the default drag start by down->move
   *     manualStart: true
   *   })
   *   // start dragging after the user holds the pointer down
   *   .on('hold', function (event) {
   *     var interaction = event.interaction;
   *
   *     if (!interaction.interacting()) {
   *       interaction.start({ name: 'drag' },
   *                         event.interactable,
   *                         event.currentTarget);
   *     }
   * });
   * ```
   *
   * Start an action with the given Interactable and Element as tartgets. The
   * action must be enabled for the target Interactable and an appropriate
   * number of pointers must be held down - 1 for drag/resize, 2 for gesture.
   *
   * Use it with `interactable.<action>able({ manualStart: false })` to always
   * [start actions manually](https://github.com/taye/interact.js/issues/114)
   *
   * @param {object} action   The action to be performed - drag, resize, etc.
   * @param {Interactable} target  The Interactable to target
   * @param {Element} element The DOM Element to target
   * @return {object} interact
   */
  start (action, target, element) {
    if (this.interacting()
        || !this.pointerIsDown
        || this.pointerIds.length < (action.name === 'gesture'? 2 : 1)) {
      return;
    }

    utils.copyAction(this.prepared, action);
    this.target         = target;
    this.element        = element;

    this._interacting = true;
    const startEvent = this._createPreparedEvent(this.downEvent, 'start', false);
    const signalArg = {
      interaction: this,
      event: this.downEvent,
      iEvent: startEvent,
    };

    this._signals.fire('action-start', signalArg);

    this._fireEvent(startEvent);

    this._signals.fire('after-action-start', signalArg);
  }

  pointerMove (pointer, event, eventTarget) {
    if (!this.simulation) {
      this.updatePointer(pointer, event, eventTarget, false);
      utils.pointer.setCoords(this.curCoords, this.pointers);
    }

    const duplicateMove = (this.curCoords.page.x === this.prevCoords.page.x
                           && this.curCoords.page.y === this.prevCoords.page.y
                           && this.curCoords.client.x === this.prevCoords.client.x
                           && this.curCoords.client.y === this.prevCoords.client.y);

    let dx;
    let dy;

    // register movement greater than pointerMoveTolerance
    if (this.pointerIsDown && !this.pointerWasMoved) {
      dx = this.curCoords.client.x - this.startCoords.client.x;
      dy = this.curCoords.client.y - this.startCoords.client.y;

      this.pointerWasMoved = utils.hypot(dx, dy) > Interaction.pointerMoveTolerance;
    }

    const signalArg = {
      pointer,
      pointerIndex: this.getPointerIndex(pointer),
      event,
      eventTarget,
      dx,
      dy,
      duplicate: duplicateMove,
      interaction: this,
      interactingBeforeMove: this.interacting(),
    };

    if (!duplicateMove) {
      // set pointer coordinate, time changes and speeds
      utils.pointer.setCoordDeltas(this.pointerDelta, this.prevCoords, this.curCoords);
    }

    this._signals.fire('move', signalArg);

    if (!duplicateMove) {
      // if interacting, fire an 'action-move' signal etc
      if (this.interacting()) {
        this.doMove(signalArg);
      }

      if (this.pointerWasMoved) {
        utils.pointer.copyCoords(this.prevCoords, this.curCoords);
      }
    }
  }

  /**
   * ```js
   * interact(target)
   *   .draggable(true)
   *   .on('dragmove', function (event) {
   *     if (someCondition) {
   *       // change the snap settings
   *       event.interactable.draggable({ snap: { targets: [] }});
   *       // fire another move event with re-calculated snap
   *       event.interaction.doMove();
   *     }
   *   });
   * ```
   *
   * Force a move of the current action at the same coordinates. Useful if
   * snap/restrict has been changed and you want a movement with the new
   * settings.
   */
  doMove (signalArg) {
    signalArg = utils.extend({
      pointer: this.pointers[0],
      event: this.prevEvent,
      eventTarget: this._eventTarget,
      interaction: this,
    }, signalArg || {});

    const beforeMoveResult = this._signals.fire('before-action-move', signalArg);

    if (beforeMoveResult !== false) {
      const moveEvent = signalArg.iEvent =
        this._createPreparedEvent(signalArg.event, 'move', signalArg.preEnd);

      this._signals.fire('action-move', signalArg);

      this._fireEvent(moveEvent);

      this._signals.fire('after-action-move', signalArg);
    }
  }

  // End interact move events and stop auto-scroll unless simulation is running
  pointerUp (pointer, event, eventTarget, curEventTarget) {
    const pointerIndex = this.getPointerIndex(pointer);

    this._signals.fire(/cancel$/i.test(event.type)? 'cancel' : 'up', {
      pointer,
      pointerIndex,
      event,
      eventTarget,
      curEventTarget,
      interaction: this,
    });

    if (!this.simulation) {
      this.end(event);
    }

    this.pointerIsDown = false;
    this.removePointer(pointer, event);
  }

  documentBlur (event) {
    this.end(event);
    this._signals.fire('blur', { event, interaction: this });
  }

  /**
   * ```js
   * interact(target)
   *   .draggable(true)
   *   .on('move', function (event) {
   *     if (event.pageX > 1000) {
   *       // end the current action
   *       event.interaction.end();
   *       // stop all further listeners from being called
   *       event.stopImmediatePropagation();
   *     }
   *   });
   * ```
   *
   * @param {PointerEvent} [event]
   */
  end (event) {
    this._ending = true;
    event = event || this.prevEvent;

    if (this.interacting()) {
      const endEvent = this._createPreparedEvent(event, 'end', false);
      const signalArg = {
        event,
        iEvent: endEvent,
        interaction: this,
      };

      const beforeEndResult = this._signals.fire('before-action-end', signalArg);

      if (beforeEndResult === false) {
        this._ending = false;
        return;
      }

      this._signals.fire('action-end', signalArg);

      this._fireEvent(endEvent);

      this._signals.fire('after-action-end', signalArg);
    }

    this._ending = false;
    this.stop();
  }

  currentAction () {
    return this._interacting? this.prepared.name: null;
  }

  interacting () {
    return this._interacting;
  }

  /** */
  stop () {
    this._signals.fire('stop', { interaction: this });

    this.target = this.element = null;

    this._interacting = false;
    this.prepared.name = this.prevEvent = null;
  }

  getPointerIndex (pointer) {
    // mouse and pen interactions may have only one pointer
    if (this.pointerType === 'mouse' || this.pointerType === 'pen') {
      return 0;
    }

    return this.pointerIds.indexOf(utils.pointer.getPointerId(pointer));
  }

  updatePointer (pointer, event, eventTarget, down = event && /(down|start)$/i.test(event.type)) {
    const id = utils.pointer.getPointerId(pointer);
    let index = this.getPointerIndex(pointer);

    if (index === -1) {
      index = this.pointerIds.length;
      this.pointerIds[index] = id;
    }

    if (down) {
      this.pointerIds[index] = id;
      this.pointers[index]   = pointer;
      this.pointerIsDown     = true;

      if (!this.interacting()) {
        utils.pointer.setCoords(this.startCoords, this.pointers);

        utils.pointer.copyCoords(this.curCoords , this.startCoords);
        utils.pointer.copyCoords(this.prevCoords, this.startCoords);

        this.downEvent          = event;
        this.downTimes[index]   = this.curCoords.timeStamp;
        this.downTargets[index] = eventTarget;
        this.pointerWasMoved    = false;

        utils.pointer.pointerExtend(this.downPointer, pointer);
      }

      this._signals.fire('update-pointer-down', {
        pointer,
        event,
        eventTarget,
        down,
        pointerId: id,
        pointerIndex: index,
        interaction: this,
      });
    }

    this.pointers[index] = pointer;

    return index;
  }

  removePointer (pointer, event) {
    const index = this.getPointerIndex(pointer);

    if (index === -1) { return; }

    this._signals.fire('remove-pointer', {
      pointer,
      event,
      pointerIndex: index,
      interaction: this,
    });

    this.pointers   .splice(index, 1);
    this.pointerIds .splice(index, 1);
    this.downTargets.splice(index, 1);
    this.downTimes  .splice(index, 1);
  }

  _updateEventTargets (target, currentTarget) {
    this._eventTarget    = target;
    this._curEventTarget = currentTarget;
  }

  _createPreparedEvent (event, phase, preEnd) {
    const actionName = this.prepared.name;

    return new InteractEvent(this, event, actionName, phase, this.element, null, preEnd);
  }

  _fireEvent (iEvent) {
    this.target.fire(iEvent);
    this.prevEvent = iEvent;
  }
}

Interaction.pointerMoveTolerance = 1;

module.exports = Interaction;
