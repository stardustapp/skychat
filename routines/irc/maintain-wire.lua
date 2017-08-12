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
      if msg.params["2"] == "VERSION" then
        sendMessage("NOTICE", {
            ["1"] = msg["prefix-name"],
            ["2"] = "\x01VERSION Stardust IRC Client\x01",
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

  MODE = function(msg) -- TODO: track umodes and chanmodes
    if ctx.read(persist, "current-nick") == msg.params["1"] then
      ctx.store(persist, "umodes", msg.params["2"])
      return true
    else
      -- gotta be a channel, right?
      local chan = getChannel(msg.params["1"])
      writeToLog(chan.log, msg)
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

  ["002"] = writeToServerLog,
  ["003"] = writeToServerLog,
  ["004"] = writeToServerLog, -- server compile config
  ["005"] = writeToServerLog, -- server limits/settings
  ["251"] = writeToServerLog, -- online users
  ["252"] = writeToServerLog, -- online operators
  ["253"] = writeToServerLog, -- "unknown" connections
  ["254"] = writeToServerLog, -- channels made
  ["255"] = writeToServerLog, -- local clients
  ["265"] = writeToServerLog, -- local users
  ["266"] = writeToServerLog, -- global users
  ["250"] = writeToServerLog, -- connection record

  -- https://www.alien.net.au/irc/irc2numerics.html

  ["401"] = writeToServerLog, -- missing recipient error
  ["404"] = writeToServerLog, -- ERR_CANNOTSENDTOCHAN
  ["411"] = writeToServerLog, -- no recipient error
  ["433"] = writeToServerLog, -- nickname in use - dialer handles this for us
  ["477"] = writeToServerLog, -- NEEDREGGEDNICK

  -- server MOTD
  ["375"] = function(msg) -- motd header
    ctx.store(state, "motd-partial", msg.params["2"])
    return false -- don't checkpoint yet
  end,
  ["372"] = function(msg) -- motd body
    partial = ctx.read(state, "motd-partial")
    ctx.store(state, "motd-partial", partial.."\n"..msg.params["2"])
    return false -- don't checkpoint yet
  end,
  ["376"] = function(msg) -- motd complete
    partial = ctx.read(state, "motd-partial")
    ctx.unlink(state, "motd-partial")
    writeToLog(serverLog, {
        timestamp = msg.timestamp,
        command = "LOG",
        sender = msg["prefix-name"],
        text = partial.."\n"..msg.params["2"],
      })
    return true -- checkpoint the full motd being saved
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
    local nicks = ctx.splitString(msg.params["4"], " ")
    for _, nickSpec in ipairs(nicks) do
      local modes = string.sub(nickSpec, 1, 1)
      local nick = nickSpec
      if modes == "@" or modes == "+" or modes == "&" or modes == "%" or modes == "~" then
        nick = string.sub(nickSpec, 2)
      else
        modes = ""
      end

      ctx.store(chan.members, nick, {
          since = ctx.read(chan.members, nick, "since"),
          nick = nick,
          modes = modes,
          nick = nick,
          user = ctx.read(chan.members, nick, "user"),
          host = ctx.read(chan.members, nick, "host"),
        })
      ctx.log("Stored nick", nick, "in", msg.params["3"])
    end
    writeToLog(chan.log, msg)
    return true
  end,
  ["366"] = function(msg) -- end of names - me, chan, msg
    local chan = getChannel(msg.params["2"])
    writeToLog(chan.log, msg)
    return true
  end,
}

-- Main loop
local healthyWire = true
while true do

  -- Check for any/all new content
  local latest = tonumber(ctx.read(wire, "history-latest"))
  if latest == checkpoint and not healthyWire then break end
  while latest > checkpoint do
    checkpoint = checkpoint + 1

    local message = ctx.readDir(wire, "history", checkpoint)
    ctx.log("New wire message", message.command)

    if message.source ~= "client" or message.command == 'PRIVMSG' or message.command == 'NOTICE' or message.command == 'CTCP' then

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
  healthyWire = wireIsHealthy()

  -- Sleep a sec
  ctx.sleep(1000)
end
