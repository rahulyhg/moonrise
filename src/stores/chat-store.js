var Dispatcher = require('../dispatcher');
var Constants = require('../constants');
var EventEmitter = require('events').EventEmitter;
var assign = require('object-assign');
var shortid = require('shortid');
var remote = require('electron').remote;
var notifier = require('../ui/notifier');

var CHANGE_EVENT = 'change';

var _chats = {};

function _createChat (id) {
  if (!_chats[id]) {
    _chats[id] = {};
    _chats[id].id = id;
    _chats[id].messages = [];
    _chats[id].visible = false;
    _chats[id].unreadMessageCount = 0;
    _chats[id].typing = false;
  }
}

function _createChatMessage (id, message) {
  _chats[id].tabbed = true;

  if (message.username) {
    _chats[id].username = message.username;
  }

  _chats[id].messages.push({
    id: shortid.generate(), // each message gets unique ID
    type: message.type,
    date: message.date,
    text: message.text,
    meta: message.meta
  });
}

function _resetUnreadMessageCount (id) {
  _chats[id].unreadMessageCount = 0;
}

function _findVisibleChat () {
  for(var id in _chats) {
    if (_chats[id].visible) {
      return _chats[id];
    }
  }
}

function _toggleVisibleChat (id) {
  var currentVisibleChat = _findVisibleChat();
  if (currentVisibleChat) {
    currentVisibleChat.visible = false;
  }

  if (id) {
    _chats[id].visible = true;
  }
}

function _findFirstToMakeVisible (cannotBeMadeVisibleId) {
  for(var id in _chats) {
    if (id !== cannotBeMadeVisibleId && _chats[id].tabbed) {
      return _chats[id];
    }
  }
}

function _invalidateTradeRequests (id) {
  if (!_chats[id]) {
    return;
  }

  _chats[id].messages.forEach(function (message) {
    if (message.meta && message.meta.tradeRequestId && !message.meta.response) {
      message.meta.response = 'Invalid';
    }
  });
}

function _getLastTradeRequest (id, ourRequestsOnly) {
  ourRequestsOnly = ourRequestsOnly || false;

  var tradeRequests = _chats[id].messages.filter(function (message) {
    if (message.type === Constants.MessageTypes.CHAT_OUR_TRADE_REQUEST) {
      return true;
    }

    if (message.type === Constants.MessageTypes.CHAT_THEIR_TRADE_REQUEST && !ourRequestsOnly) {
      return true;
    }

    return false;
  });

  if (tradeRequests.length > 0) {
    return tradeRequests[tradeRequests.length - 1];
  }
}

function _getTradeRequestById (userId, tradeRequestId) {
  var messages = _chats[userId].messages.filter(function (message) {
    if (message.meta && message.meta.tradeRequestId === tradeRequestId) {
      return true;
    }
    return false;
  });

  // this should always match only a single trade request (message)
  if (messages.length > 0) {
    return messages[0];
  }
}

function openChat (user) {
  var id = user.id;
  var username = user.username;

  _createChat(id);
  _toggleVisibleChat(id);
  _resetUnreadMessageCount(id);

  _chats[id].username = username;
  _chats[id].tabbed = true;
}

function switchChat (chat) {
  var id = chat.id;

  _toggleVisibleChat(id);
  _resetUnreadMessageCount(id);
}

function closeChat (chat) {
  var id = chat.id;

  _chats[id].tabbed = false;

  if (_chats[id].visible) {
    _chats[id].visible = false;

    var toBeMadeVisible = _findFirstToMakeVisible(id);
    if (toBeMadeVisible) {
      toBeMadeVisible.visible = true;
      _resetUnreadMessageCount(toBeMadeVisible.id);
    }
  }
};

function clearChat (chat) {
  var id = chat.id;

  if (_chats[id]) {
    _chats[id].messages = [];
  }
}

function newIncomingMessage (message) {
  _createChat(message.sender);
  _createChatMessage(message.sender, message);

  var currentChat = _chats[message.sender];

  // make visible if necessary
  var currentVisibleChat = _findVisibleChat();
  if (!currentVisibleChat) {
    currentChat.visible = true;
  }

  // increase unread count if necessary
  if (!currentChat.visible) {
    currentChat.unreadMessageCount++;
  }

  // mark as not typing
  currentChat.typing = false;

  // notify user if needed
  if (!currentChat.visible || !remote.getCurrentWindow().isFocused()) {
    notifier.message({
      username: message.username,
      text: message.text,
      chat: currentChat,
      playSound: true
    });
  }

  // flash the window if it has no focus
  if (!remote.getCurrentWindow().isFocused()) {
    notifier.flash('informational');
  }
}

function newOutgoingMessage (message) {
  _createChat(message.target);
  _createChatMessage(message.target, message);

  // make visible if necessary
  var currentVisibleChat = _findVisibleChat();
  if (!currentVisibleChat) {
    _chats[message.target].visible = true;
  }
}

function respondToTradeRequest (chat, message, response) {
  _invalidateTradeRequests(chat.id);

  message.meta.response = response ? 'Accepted' : 'Declined';
}

function incomingTradeRequestResponse (response) {
  _invalidateTradeRequests(response.id);

  if (response.tradeRequestId === 0) {
    // assume this concerns the very last trade request
    var message = _getLastTradeRequest(response.id);
    if (message) {
      message.meta.response = response.responseEnum;
    }
  } else {
    var message = _getTradeRequestById(response.id, response.tradeRequestId);

    if (message) {
      message.meta.response = response.responseEnum;
    } else {
      // trade request ID did not match, this is probably a trade request which we sent
      var message = _getLastTradeRequest(response.id, true);
      if (message) {
        message.meta.response = response.responseEnum;
      }
    }
  }
}

function remove (id) {
  if (!_chats[id]) {
    return;
  }

  if (_chats[id].visible) {
    _chats[id].visible = false;

    var toBeMadeVisible = _findFirstToMakeVisible(id);
    if (toBeMadeVisible) {
      toBeMadeVisible.visible = true;
      _resetUnreadMessageCount(toBeMadeVisible.id);
    }
  }

  delete _chats[id];
}

function otherUserIsTyping (steamId) {
  if (!_chats[steamId]) {
    return;
  }

  _chats[steamId].typing = true;
}

function otherUserStoppedTyping (steamId) {
  if (!_chats[steamId]) {
    return;
  }

  _chats[steamId].typing = false;
}

function clear () {
  _chats = {};
}

var ChatStore = assign({}, EventEmitter.prototype, {

  emitChange: function () {
    this.emit(CHANGE_EVENT);
  },

  addChangeListener: function (callback) {
    this.on(CHANGE_EVENT, callback);
  },

  removeChangeListener: function (callback) {
    this.removeListener(CHANGE_EVENT, callback);
  },

  get: function (id) {
    return _chats[id];
  },

  getAll: function () {
    return _chats;
  },

  getVisible: function () {
    for(var id in _chats) {
      if (_chats[id].visible) {
        return _chats[id];
      }
    }
  },

  getLastIncomingTradeRequestId: function (id) {
    var incomingTradeRequests = _chats[id].messages.filter(function (message) {
      if (message.type === Constants.MessageTypes.CHAT_THEIR_TRADE_REQUEST && message.meta && message.meta.tradeRequestId) {
        return true;
      }
      return false;
    });

    if (incomingTradeRequests.length > 0) {
      return incomingTradeRequests[incomingTradeRequests.length - 1].meta.tradeRequestId;
    }
  }

});

ChatStore.dispatchToken = Dispatcher.register(function (action) {
  switch (action.type) {
    case Constants.ChatActions.CHAT_OPEN:
      openChat(action.user);
      ChatStore.emitChange();
      break;

    case Constants.ChatActions.CHAT_SWITCH:
      switchChat(action.chat);
      ChatStore.emitChange();
      break;

    case Constants.ChatActions.CHAT_CLOSE:
      closeChat(action.chat);
      ChatStore.emitChange();
      break;

    case Constants.ChatActions.CHAT_CLEAR:
      clearChat(action.chat);
      ChatStore.emitChange();
      break;

    case Constants.ChatActions.CHAT_NEW_INCOMING_MESSAGE:
      newIncomingMessage(action.message);
      ChatStore.emitChange();
      break;

    case Constants.ChatActions.CHAT_NEW_OUTGOING_MESSAGE:
    case Constants.ChatActions.CHAT_ECHO_MESSAGE:
      newOutgoingMessage(action.message);
      ChatStore.emitChange();
      break;

    case Constants.ChatActions.CHAT_RESPOND_TO_TRADE_REQUEST:
      respondToTradeRequest(action.chat, action.message, action.response);
      ChatStore.emitChange();
      break;

    case Constants.ChatActions.CHAT_INCOMING_TRADE_REQUEST_RESPONSE:
      incomingTradeRequestResponse(action.response);
      ChatStore.emitChange();
      break;

    case Constants.ChatActions.OTHER_USER_IS_TYPING:
      otherUserIsTyping(action.steamId);
      ChatStore.emitChange();
      break;

    case Constants.ChatActions.OTHER_USER_STOPPED_TYPING:
      otherUserStoppedTyping(action.steamId);
      ChatStore.emitChange();
      break;

    case Constants.FriendsActions.FRIENDS_SEND_TRADE_REQUEST:
      var friend = action.friend;

      var message = {
        type: Constants.MessageTypes.CHAT_OUR_TRADE_REQUEST,
        target: friend.id,
        username: friend.username,
        date: new Date(),
        text: 'You have sent a trade request to ' + friend.username + '.',
        meta: {}
      };

      newOutgoingMessage(message);
      ChatStore.emitChange();
      break;

    case Constants.FriendsActions.FRIENDS_REMOVE:
      remove(action.friend.id);
      ChatStore.emitChange();
      break;

    case Constants.FriendsActions.FRIENDS_PURGE:
      remove(action.id);
      ChatStore.emitChange();
      break;

    case Constants.UIActions.UI_LOGOUT:
      clear();
      ChatStore.emitChange();
      break;

    default:
      // ignore
  }
});

module.exports = ChatStore;
