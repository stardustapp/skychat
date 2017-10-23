ctx.log("I'm here to maintain", input.network,
  "and chew bubblegum, and I'm all out of bubblegum")

local config = ctx.mkdirp("config", "networks", input.network)
local state = ctx.mkdirp("state", "networks", input.network)
local persist = ctx.mkdirp("persist", "networks", input.network)
local wire = ctx.mkdirp(state, "wire") -- TODO: should not be a mkdirp

-- Queue an IRC payload for transmission to server
function sendMessage(command, params)
  ctx.invoke(wire, "send", {
      command=command,
      params=params,
    })
end

-- Helper to verify the wire isn't dead
function wireIsHealthy()
  local status = ctx.read(wire, "state")
  if status == "Pending" or status == "Ready" then
    return true
  end

  ctx.store(state, "status", "Failed: Wire was state "..status.." at "..ctx.timestamp())
  ctx.unlink(persist, "wire-uri")
  ctx.log("Cutting ties with wire - status was", status)
  return false
end

-- Pass a partitioned log context and an entry with 'timestamp' field, at minimum
-- NOT thread-safe - only write logs from one routine!
function writeToLog(log, entry)
  local partitionId = string.sub(entry.timestamp, 1, 10)
  local partition = ctx.mkdirp(log, partitionId)

  -- seed the log with this partition if it's all new
  if ctx.read(log, "horizon") == "" then
    ctx.store(log, "horizon", partitionId)
    ctx.store(log, "latest", partitionId)
  end

  -- seed the individual partition if it's new
  if ctx.read(log, partitionId, "horizon") == "" then
    ctx.log("Creating new partition", partitionId, "for log", log)
    ctx.store(partition, "horizon", 0)
    ctx.store(partition, "latest", -1)

    -- update log to use new partition
    if ctx.read(log, "latest") < partitionId then
      ctx.store(log, "latest", partitionId)
    end
  end

  -- store using next ID from partition
  local lastId = tonumber(ctx.read(log, partitionId, "latest"))
  local nextId = ""..(lastId + 1)
  ctx.store(partition, nextId, entry)
  ctx.store(partition, "latest", nextId)
  ctx.log("Wrote message", nextId, "into", partitionId, "for", log)
  return partitionId.."/"..nextId
end

-- Load existing windows into cache and present APIs
--local windows = {}
--local configs = ctx.enumerate(persist, "logs", "channels")
--for _, config in ipairs(configs) do

-- Restore checkpoint from stored state
local savedCheckpoint = ctx.read(persist, "wire-checkpoint")
local checkpoint = tonumber(savedCheckpoint) or -1
ctx.log("Resuming after wire checkpoint", checkpoint)

-- Create some basic folders
local serverLog   = ctx.mkdirp(persist, "server-log")
local mentionLog   = ctx.mkdirp(persist, "mention-log")
local channelsCtx = ctx.mkdirp(persist, "channels")
local queriesCtx  = ctx.mkdirp(persist, "queries")

-- Helper to assemble a channel state
local channelCache = {}
function getChannel(name)
  local table = channelCache[name]
  if not table then
    -- TODO: membership and modes should clear when wire changes over
    table = {
      root    = ctx.mkdirp(channelsCtx, name),
      log     = ctx.mkdirp(channelsCtx, name, "log"),
      members = ctx.mkdirp(channelsCtx, name, "membership"),
      modes   = ctx.mkdirp(channelsCtx, name, "modes"),
      topic   = ctx.mkdirp(channelsCtx, name, "topic"),
    }
    channelCache[name] = table
  end
  return table
end

-- Helper to assemble a query state
local queryCache = {}
function getQuery(name)
  local table = queryCache[name]
  if not table then
    -- TODO: other user's state should clear when wire changes over
    table = {
      root    = ctx.mkdirp(queriesCtx, name),
      log     = ctx.mkdirp(queriesCtx, name, "log"),
    }
    queryCache[name] = table
  end
  return table
end

function writeToServerLog(msg)
  writeToLog(serverLog, msg)
  return true
end

-- Detect, store, and indicate any mention of the current user
function isDirectMention(message)
  local nick = string.lower(ctx.read(persist, "current-nick"))
  local nickLen = string.len(nick)

  local words = ctx.splitString(message, " ")
  for _, word in ipairs(words) do
    local wordPart = string.lower(string.sub(word, 1, nickLen))
    if wordPart == nick then
      ctx.log("Detected mention of", nick, "in msg:", message)
      return true
    end
  end
  return false
end

function handleMention(msg, where, sender, text)
  writeToLog(mentionLog, {
      timestamp = msg["timestamp"],
      location = where,
      sender = sender,
      text = text,
      raw = msg,
    })

  ctx.invoke("session", "notifier", "send-message", {
      text = text,
      title = "IRC: "..sender.." mentioned you in "..where,
      level = "2",
      -- link = "https://devmode.cloud/~dan/irc/",
    })
end

function listChannelsWithUser(nick)
  local chans = {}
  local allChans = ctx.enumerate(channelsCtx, "")
  for _, chanEnt in ipairs(allChans) do
    local chan = getChannel(chanEnt.name)

    if ctx.read(chan.members, nick, "nick") ~= "" then
      chans[chanEnt.name] = chan
    end
  end
  return chans
end

local lastMsg = ""
local lastMsgCount = 0

-- Lookup table for IRC message handlers
local handlers = {
  LOG = function(msg)
    writeToLog(serverLog, {
        timestamp = msg.timestamp,
        command = msg.command,
        sender = source,
        text = msg.params["1"],
      })
    return true
  end,
  NOTICE = function(msg)
    if msg.source == "server" and msg["prefix-host"] == "" then
      -- servers talk directly to us without a host
      writeToLog(serverLog, {
          timestamp = msg.timestamp,
          command = msg.command,
          sender = msg["prefix-name"],
          text = msg.params["2"],
        })
      return true

    elseif msg.params["1"]:sub(1,1) == "#" then
      -- to a channel
      local chan = getChannel(msg.params["1"])
      local logId = writeToLog(chan.log, msg)
      ctx.store(chan.root, "latest-activity", logId)
      return true

    elseif msg.params["1"] == ctx.read(persist, "current-nick") then
      -- it was direct to me
      local query = getQuery(msg["prefix-name"])
      local logId = writeToLog(query.log, msg)
      ctx.store(query.root, "latest-activity", logId)
      return true

    else
      -- it was from me, direct to someone else
      local query = getQuery(msg.params["1"])
      local logId = writeToLog(query.log, msg)
      return true

    end
  end,
  PRIVMSG = function(msg)
    if msg.params["1"]:sub(1,1) == "#" then

      -- indicate mentions before we store the message
      if isDirectMention(msg.params["2"]) then
        msg["is-mention"] = true
      end

      -- to a channel, let's archive it
      local chan = getChannel(msg.params["1"])
      local logId = writeToLog(chan.log, msg)
      ctx.store(chan.root, "latest-activity", logId)

      -- botwurst chain feature
      if msg.params["2"] == lastMsg then
        lastMsgCount = lastMsgCount + 1
        if lastMsgCount == 3 then
          sendMessage("PRIVMSG", {
              ["1"] = msg.params["1"],
              ["2"] = lastMsg,
            })
        end
      else
        lastMsg = msg.params["2"]
        lastMsgCount = 1
      end

      -- other commands
      if msg.params["2"] == "!ping" then
        sendMessage("PRIVMSG", {
            ["1"] = msg.params["1"],
            ["2"] = "Pong!",
          })
      end

      -- mentions also go other places
      if msg["is-mention"] then
        handleMention(msg, msg.params["1"], msg["prefix-name"], msg.params["2"])
        ctx.store(chan.root, "latest-mention", logId)
      end

      return true

    elseif msg.params["1"] == ctx.read(persist, "current-nick") then
      -- it was direct to me
      local query = getQuery(msg["prefix-name"])
      local logId = writeToLog(query.log, msg)

      ctx.store(query.root, "latest-activity", logId)
      -- TODO: ideally not EVERY pm is a mention
      handleMention(msg, "direct message", msg["prefix-name"], msg.params["2"])
      --ctx.store(chan.root, "latest-mention", logId)

      return true

    else
      -- it was from me, direct to someone else
      local query = getQuery(msg.params["1"])
      local logId = writeToLog(query.log, msg)
      return true

    end
  end,
  CTCP = function(msg)
    if msg.params["1"]:sub(1,1) == "#" then
      -- to a channel, let's find it
      local chan = getChannel(msg.params["1"])
      local logId = writeToLog(chan.log, msg)
      ctx.store(chan.root, "latest-activity", logId)
      return true

    elseif msg.params["1"] == ctx.read(persist, "current-nick") then
      -- it was direct to me
      local query = getQuery(msg["prefix-name"])
      local logId = writeToLog(query.log, msg)
      ctx.store(query.root, "latest-activity", logId)

      -- CTCP commands
      local words = ctx.splitString(msg.params["2"], " ")
      if words[1] == "version" then
        sendMessage("CTCP_ANSWER", {
            ["1"] = msg["prefix-name"],
            ["2"] = "VERSION",
            ["3"] = "Stardust IRC Client",
          })
      elseif words[1] == "PING" then
        table.remove(words, 1)
        sendMessage("CTCP_ANSWER", {
            ["1"] = msg["prefix-name"],
            ["2"] = "PING",
            ["3"] = table.concat(words, " "),
          })
      elseif words[1] == "TIME" then
        sendMessage("CTCP_ANSWER", {
            ["1"] = msg["prefix-name"],
            ["2"] = "TIME",
            ["3"] = ctx.timestamp(),
          })
      end

      return true

    else
      -- it was from me, probably direct to someone else
      local query = getQuery(msg.params["1"])
      local logId = writeToLog(query.log, msg)
      return true

    end
  end,
  CTCP_ANSWER = function(msg)
    if msg.params["1"]:sub(1,1) == "#" then
      -- to a channel, let's find it
      local chan = getChannel(msg.params["1"])
      local logId = writeToLog(chan.log, msg)
      ctx.store(chan.root, "latest-activity", logId)
      return true

    elseif msg.params["1"] == ctx.read(persist, "current-nick") then
      -- it was direct to me
      local query = getQuery(msg["prefix-name"])
      local logId = writeToLog(query.log, msg)
      ctx.store(query.root, "latest-activity", logId)
      return true

    else
      -- it was from me, hopefully direct to someone else
      local query = getQuery(msg.params["1"])
      local logId = writeToLog(query.log, msg)
      return true

    end
  end,
  JOIN = function(msg)
    local chan = getChannel(msg.params["1"])
    ctx.store(chan.members, msg["prefix-name"], {
        since = msg.timestamp,
        nick = msg["prefix-name"],
        user = msg["prefix-user"],
        host = msg["prefix-host"],
      })
    writeToLog(chan.log, msg)

    if ctx.read(persist, "current-nick") == msg["prefix-name"] then
      ctx.store(chan.root, "is-joined", true)
    end
    return true
  end,
  PART = function(msg)
    local chan = getChannel(msg.params["1"])
    ctx.unlink(chan.members, msg["prefix-name"])
    writeToLog(chan.log, msg)

    if ctx.read(persist, "current-nick") == msg["prefix-name"] then
      ctx.store(chan.root, "is-joined", false)
    end
    return true
  end,
  KICK = function(msg)
    local chan = getChannel(msg.params["1"])
    ctx.unlink(chan.members, msg.params["2"])
    writeToLog(chan.log, msg)

    if ctx.read(persist, "current-nick") == msg.params["2"] then
      ctx.store(chan.root, "is-joined", false)
    end
    return true
  end,
  PING = function() return true end,
  PONG = function() return true end, -- TODO: time out eventually?

  INVITE = function(msg)
    local chan = getChannel(msg.params["2"])
    local logId = writeToLog(chan.log, msg)

    if ctx.read(persist, "current-nick") == msg.params["1"] then
      ctx.store(chan.root, "invitation", msg)
      ctx.store(chan.root, "latest-activity", logId)
    end
    return true
  end,

  MODE = function(msg) -- TODO: track umodes and chanmodes
    if msg.params["1"]:sub(1,1) == "#" then
      -- to a channel, let's find it
      local chan = getChannel(msg.params["1"])
      local logId = writeToLog(chan.log, msg)
      return true

    elseif msg.params["1"] == ctx.read(persist, "current-nick") then
      -- it was direct to me
      writeToLog(serverLog, msg)
      ctx.store(persist, "umodes", msg.params["2"])
      return true
    end
  end,

  TOPIC = function(msg)
    local chan = getChannel(msg.params["1"])
    local logId = writeToLog(chan.log, msg)
    ctx.store(chan.root, "latest-activity", logId)

    ctx.store(chan.topic, "latest", msg.params["2"])
    ctx.store(chan.topic, "set-by", msg["prefix-name"].."!"..msg["prefix-user"].."@"..msg["prefix-host"])
    ctx.store(chan.topic, "set-at", msg.timestamp)
    return true
  end,

  NICK = function(msg)
    -- update my nick if it's me
    if ctx.read(persist, "current-nick") == msg["prefix-name"] then
      ctx.store(persist, "current-nick", msg.params["1"])
    end

    local channels = listChannelsWithUser(msg["prefix-name"])
    for name, chan in pairs(channels) do
      existingEnt = ctx.readDir(chan.members, msg["prefix-name"])
      existingEnt.nick = msg.params["1"]
      existingEnt.user = msg["prefix-user"]
      existingEnt.host = msg["prefix-host"]

      ctx.store(chan.members, msg.params["1"], existingEnt)
      ctx.unlink(chan.members, msg["prefix-name"])
      writeToLog(chan.log, msg)
    end
    return true
  end,

  QUIT = function(msg)
    local channels = listChannelsWithUser(msg["prefix-name"])
    for name, chan in pairs(channels) do
      ctx.unlink(chan.members, msg["prefix-name"])
      writeToLog(chan.log, msg)
    end
    return true
  end,
  ["KILL"]  = writeToServerLog,
  ["ERROR"] = writeToServerLog,

  ["001"] = function(msg)
    writeToLog(serverLog, msg)
    ctx.store(persist, "current-nick", msg.params["1"])
    ctx.store(state, "status", "Ready")

    ctx.log("Connection is ready - joining all configured channels")
    local channels = ctx.enumerate(config, "channels")
    for _, chan in ipairs(channels) do
      ctx.log("Auto-joining channel", chan.stringValue)
      sendMessage("JOIN", {["1"] = chan.stringValue})
    end
    return true
  end,

  ["002"] = writeToServerLog, -- RPL_YOURHOST
  ["003"] = writeToServerLog, -- RPL_CREATED
  ["004"] = writeToServerLog, -- RPL_MYINFO server compile config
  ["005"] = writeToServerLog, -- RPL_MYINFO server limits/settings
  ["042"] = writeToServerLog, -- RPL_YOURID [Mozilla]
  ["251"] = writeToServerLog, -- RPL_LUSERCLIENT online users
  ["252"] = writeToServerLog, -- RPL_LUSEROP online operators
  ["253"] = writeToServerLog, -- RPL_LUSERUNKNOWN "unknown" connections
  ["254"] = writeToServerLog, -- RPL_LUSERCHANNELS channels made
  ["255"] = writeToServerLog, -- RPL_LUSERME local clients
  ["265"] = writeToServerLog, -- RPL_LOCALUSERS local users
  ["266"] = writeToServerLog, -- RPL_GLOBALUSERS global users
  ["250"] = writeToServerLog, -- RPL_GLOBALUSERS connection record

  ["221"] = function(msg) -- RPL_UMODEIS modes [params]
    ctx.store(persist, "umodes", msg.params["2"])
    writeToServerLog(msg)
    return true
  end,

  -- https://www.alien.net.au/irc/irc2numerics.html

  ["396"] = writeToServerLog, -- RPL_HOSTHIDDEN [Mozilla]
  ["401"] = writeToServerLog, -- ERR_NOSUCHNICK missing recipient error
  ["403"] = writeToServerLog, -- ERR_NOSUCHCHANNEL
  ["404"] = writeToServerLog, -- ERR_CANNOTSENDTOCHAN
  ["411"] = writeToServerLog, -- ERR_NORECIPIENT no recipient error
  ["433"] = writeToServerLog, -- ERR_NICKNAMEINUSE nickname in use - dialer handles this for us
  ["461"] = writeToServerLog, -- ERR_NEEDMOREPARAMS -- client failure
  ["473"] = writeToServerLog, -- ERR_INVITEONLYCHAN
  ["477"] = writeToServerLog, -- ERR_NEEDREGGEDNICK

  -- WHOIS stuff - should be bundled together tbh
  ["311"] = writeToServerLog, -- RPL_WHOISUSER - nick, user, host, '*', realname
  ["312"] = writeToServerLog, -- RPL_WHOISSERVER - nick, server, serverinfo
  ["313"] = writeToServerLog, -- RPL_WHOISOPERATOR - nick, privs
  ["314"] = writeToServerLog, -- RPL_WHOWASUSER - nick, user, host, '*', realname
  ["317"] = writeToServerLog, -- RPL_WHOISIDLE - nick, seconds, flavor
  ["318"] = writeToServerLog, -- RPL_ENDOFWHOIS - nick, flavor
  ["671"] = writeToServerLog, -- RPL_WHOISSECURE - nick, type[, flavor]
  ["319"] = writeToServerLog, -- RPL_WHOISCHANNELS - nick, channels (w/ mode prefix)
  ["330"] = writeToServerLog, -- RPL_WHOISACCOUNT - nick, account, flavor
  ["378"] = writeToServerLog, -- RPL_WHOISHOST - nick, flavor w/ host
  --[""] = writeToServerLog, --
  --[""] = writeToServerLog, --

  -- SASL stuff i think
  ["900"] = writeToServerLog, -- [Mozilla] <nick!user@host> <account> :You are now logged in as <account>.


  ["486"] = function(msg) -- ERR_NONONREG nick message
    local query = getQuery(msg.params["2"])
    local logId = writeToLog(query.log, msg)
    ctx.store(query.root, "latest-activity", logId)
    return true
  end,

  -- server MOTD
  ["375"] = function(msg) -- RPL_MOTDSTART motd header
    ctx.store(state, "motd-partial", msg.params["2"])
    return false -- don't checkpoint yet
  end,
  ["372"] = function(msg) -- RPL_MOTD motd body
    partial = ctx.read(state, "motd-partial")
    ctx.store(state, "motd-partial", partial.."\n"..msg.params["2"])
    return false -- don't checkpoint yet
  end,
  ["376"] = function(msg) -- RPL_ENDOFMOTD motd complete
    partial = ctx.read(state, "motd-partial")
    ctx.unlink(state, "motd-partial")
    writeToLog(serverLog, {
        timestamp = msg.timestamp,
        command = "LOG",
        sender = msg["prefix-name"].."|motd",
        text = partial.."\n"..msg.params["2"],
      })
    return true -- checkpoint the full motd being saved
  end,

  -- server info -- matches MOTD batching code, basically - not DRY
  ["371"] = function(msg) -- RPL_INFO info body -- there is no Start from freenode
    partial = ctx.read(state, "info-partial")
    ctx.store(state, "info-partial", partial.."\n"..msg.params["2"])
    return false -- don't checkpoint yet
  end,
  ["374"] = function(msg) -- RPL_ENDOFINFO info complete
    partial = ctx.read(state, "info-partial")
    ctx.unlink(state, "info-partial")
    writeToLog(serverLog, {
        timestamp = msg.timestamp,
        command = "LOG",
        sender = msg["prefix-name"].."|info",
        text = partial.."\n"..msg.params["2"],
      })
    return true -- checkpoint the full motd being saved
  end,

  -- server help -- matches MOTD batching code, basically - not DRY
  ["704"] = function(msg) -- RPL_HELPSTART
    ctx.store(state, "help-partial", msg.params["3"])
    return false -- don't checkpoint yet
  end,
  ["705"] = function(msg) -- RPL_HELPTXT
    partial = ctx.read(state, "help-partial")
    ctx.store(state, "help-partial", partial.."\n"..msg.params["3"])
    return false -- don't checkpoint yet
  end,
  ["706"] = function(msg) -- RPL_ENDOFHELP
    partial = ctx.read(state, "help-partial")
    ctx.unlink(state, "help-partial")
    writeToLog(serverLog, {
        timestamp = msg.timestamp,
        command = "LOG",
        sender = msg["prefix-name"].."|help: "..msg.params["2"],
        text = partial.."\n"..msg.params["3"],
      })
    return true -- checkpoint the full help being saved
  end,

  -- channel topics
  ["332"] = function(msg) -- topic - me, chan, topic
    local chan = getChannel(msg.params["2"])
    writeToLog(chan.log, msg)
    ctx.store(chan.topic, "latest", msg.params["3"])
    return true
  end,
  ["333"] = function(msg) -- topic meta - me, chan, setpath, setepochseconds
    local chan = getChannel(msg.params["2"])
    writeToLog(chan.log, msg)
    ctx.store(chan.topic, "set-by", msg.params["3"])
    ctx.store(chan.topic, "set-at", msg.params["4"])
    return true
  end,
  ["328"] = function(msg) -- channel URL - me, chan, url
    local chan = getChannel(msg.params["2"])
    writeToLog(chan.log, msg)
    ctx.store(chan.root, "channel-url", msg.params["3"])
    return true
  end,

  -- channel membership list
  ["353"] = function(msg) -- names - me, '=', chan, space-sep nick list w/ modes
    local chan = getChannel(msg.params["3"])
    writeToLog(chan.log, msg)

    -- start a names enumeration
    -- we want to notice who isn't here anymore
    if chan.namesList == nil then
      ctx.log("Starting NAMES processing for", msg.params["3"])
      chan.namesList = {
        prev = ctx.readDir(chan.members),
        new = {},
      }
    end

    local nicks = ctx.splitString(msg.params["4"], " ")
    for _, nickSpec in ipairs(nicks) do
      local modes = string.sub(nickSpec, 1, 1)
      local nick = nickSpec
      if modes == "@" or modes == "+" or modes == "&" or modes == "%" or modes == "~" then
        nick = string.sub(nickSpec, 2)
      else
        modes = ""
      end

      -- find or create record of presence
      local record = chan.namesList.prev[nick]
      if record ~= nil then
        chan.namesList.prev[nick] = nil
        record.modes = modes
      else
        record = {
          nick = nick,
          modes = modes,
        }
      end

      chan.namesList.new[nick] = record
      ctx.log("Stored nick", nick, "in", msg.params["3"])
    end
    return false
  end,
  ["366"] = function(msg) -- end of names - me, chan, msg
    local chan = getChannel(msg.params["2"])
    writeToLog(chan.log, msg)

    -- submit the pending namelist update
    if chan.namesList ~= nil then
      ctx.log("Committing namelist for", msg.params["2"])
      ctx.store(chan.root, "membership", chan.namesList.new)
      chan.members = ctx.mkdirp(chan.root, "membership")
      chan.namesList = nil
    end

    return true
  end,
}

-- Main loop
local healthyWire = true
local pingCounter = 0
while healthyWire do

  local latest = tonumber(ctx.read(wire, "history-latest"))

  -- Break if...
  -- Fully processed an unhealthy wire?
  if not healthyWire and latest == checkpoint then break end
  -- Wire host went away? Can't fully process :(
  if latest == nil then break end

  -- Process any/all new content
  while latest > checkpoint do
    checkpoint = checkpoint + 1

    local message = ctx.readDir(wire, "history", checkpoint)
    ctx.log("New wire message", message.command)

    if message.command == nil then
      -- when does this happen?
      ctx.log("Nil command on msg:", message)

    elseif message.source ~= "client" or message.command == 'PRIVMSG' or message.command == 'NOTICE' or message.command == 'CTCP' then

      local handler = handlers[message.command]
      if type(handler) ~= "function" then
        error("IRC command "..message.command.." not handled - wire sequence #"..checkpoint)
      end

      if handler(message) == true then
        -- only checkpoint when handler says to
        ctx.store(persist, "wire-checkpoint", checkpoint)
      end

    else
      -- the message is from us - TODO: privmsg should record, nothing else tho
      ctx.store(persist, "wire-checkpoint", checkpoint)

    end
  end

  -- Ping / check health every minute
  pingCounter = pingCounter + 1
  if pingCounter > 60 then
    sendMessage("PING", {
        ["1"] = "maintain-wire "..ctx.timestamp(),
      })
    healthyWire = wireIsHealthy()
    pingCounter = 1
  end

  -- Sleep a sec
  ctx.sleep(1000)
end

if ctx.read(state, "status") == "Ready" then
  ctx.store(state, "status", "Completed at "..ctx.timestamp())
end
