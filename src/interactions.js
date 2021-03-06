const Interaction  = require('./Interaction');
const events       = require('./utils/events');
const finder       = require('./utils/interactionFinder');
const browser      = require('./utils/browser');
const domObjects   = require('./utils/domObjects');
const pointerUtils = require('./utils/pointerUtils');
const Signals      = require('./utils/Signals');

const methodNames = [
  'pointerDown', 'pointerMove', 'pointerUp',
  'updatePointer', 'removePointer', 'windowBlur',
];

function init (scope) {
  const signals = Signals.new();

  const listeners = {};

  for (const method of methodNames) {
    listeners[method] = doOnInteractions(method, scope);
  }

  const eventMap = { /* 'eventType': listenerFunc */ };
  const pEventTypes = browser.pEventTypes;

  if (domObjects.PointerEvent) {
    eventMap[pEventTypes.down  ] = listeners.pointerDown;
    eventMap[pEventTypes.move  ] = listeners.pointerMove;
    eventMap[pEventTypes.up    ] = listeners.pointerUp;
    eventMap[pEventTypes.cancel] = listeners.pointerUp;
  }
  else {
    eventMap.mousedown   = listeners.pointerDown;
    eventMap.mousemove   = listeners.pointerMove;
    eventMap.mouseup     = listeners.pointerUp;

    eventMap.touchstart  = listeners.pointerDown;
    eventMap.touchmove   = listeners.pointerMove;
    eventMap.touchend    = listeners.pointerUp;
    eventMap.touchcancel = listeners.pointerUp;
  }

  eventMap.blur = event => {
    for (const interaction of scope.interactions) {
      interaction.documentBlur(event);
    }
  };

  scope.signals.on('add-document'   , onDocSignal);
  scope.signals.on('remove-document', onDocSignal);

  // for ignoring browser's simulated mouse events
  scope.prevTouchTime = 0;

  // all active and idle interactions
  scope.interactions = [];
  scope.Interaction = {
    signals,
    Interaction,
    new (options) {
      options.signals = signals;

      return new Interaction(options);
    },
    listeners,
    eventMap,
  };

  scope.actions = {
    names: [],
    methodDict: {},
  };
}

function doOnInteractions (method, scope) {
  return (function (event) {
    const { interactions } = scope;

    const pointerType = pointerUtils.getPointerType(event);
    const [eventTarget, curEventTarget] = pointerUtils.getEventTargets(event);
    const matches = []; // [ [pointer, interaction], ...]

    if (browser.supportsTouch && /touch/.test(event.type)) {
      scope.prevTouchTime = new Date().getTime();

      for (const changedTouch of event.changedTouches) {
        const pointer = changedTouch;
        const pointerId = pointerUtils.getPointerId(pointer);
        const interaction = getInteraction({
          pointer,
          pointerId,
          pointerType,
          eventType: event.type,
          eventTarget,
          scope,
        });

        matches.push([pointer, interaction]);
      }
    }
    else {
      let invalidPointer = false;

      if (!browser.supportsPointerEvent && /mouse/.test(event.type)) {
        // ignore mouse events while touch interactions are active
        for (let i = 0; i < interactions.length && !invalidPointer; i++) {
          invalidPointer = interactions[i].pointerType !== 'mouse' && interactions[i].pointerIsDown;
        }

        // try to ignore mouse events that are simulated by the browser
        // after a touch event
        invalidPointer = invalidPointer
          || (new Date().getTime() - scope.prevTouchTime < 500)
          // on iOS and Firefox Mobile, MouseEvent.timeStamp is zero if simulated
          || event.timeStamp === 0;
      }

      if (!invalidPointer) {
        const interaction = getInteraction({
          pointer: event,
          pointerId: pointerUtils.getPointerId(event),
          pointerType,
          eventType: event.type,
          eventTarget,
          scope,
        });

        matches.push([event, interaction]);
      }
    }

    for (const [pointer, interaction] of matches) {
      interaction._updateEventTargets(eventTarget, curEventTarget);
      interaction[method](pointer, event, eventTarget, curEventTarget);
    }
  });
}

function getInteraction (searchDetails) {
  const { pointerType, scope } = searchDetails;

  const foundInteraction = finder.search(searchDetails);
  const signalArg = { interaction: foundInteraction, searchDetails };

  scope.Interaction.signals.fire('find', signalArg);

  return signalArg.interaction || newInteraction({ pointerType }, scope);
}

function newInteraction (options, scope) {
  const interaction = scope.Interaction.new(options);

  scope.interactions.push(interaction);
  return interaction;
}

function onDocSignal ({ doc, scope, options }, signalName) {
  const { delegatedEvents, eventMap } = scope.Interaction;
  const eventMethod = signalName.indexOf('add') === 0
    ? events.add : events.remove;

  // delegate event listener
  for (const eventType in delegatedEvents) {
    eventMethod(doc, eventType, events.delegateListener);
    eventMethod(doc, eventType, events.delegateUseCapture, true);
  }

  const eventOptions = options && options.events;

  for (const eventType in eventMap) {
    eventMethod(doc, eventType, eventMap[eventType], eventOptions);
  }
}

module.exports = {
  init,
  onDocSignal,
  doOnInteractions,
  newInteraction,
  methodNames,
};
