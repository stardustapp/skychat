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

  if not log.setup then
    ctx.log("Setting up log", log.root)

    -- seed the log with this partition if it's all new
    if ctx.read(log.root, "horizon") == "" then
      ctx.store(log.root, "horizon", partitionId)
      ctx.store(log.root, "latest", partitionId)
    end
    log.setup = true
  end

  local partition = log.parts[partitionId]
  local isNewPart = false
  if not partition then
    ctx.log("Setting up log part", log.root, partitionId)

    -- seed the individual partition if it's new
    if ctx.read(log.root, partitionId, "horizon") == "" then
      local partRoot = ctx.mkdirp(log.root, partitionId)
      ctx.log("Creating new partition", partitionId, "for log", log.root)
      ctx.store(partRoot, "horizon", 0)
      ctx.store(partRoot, "latest", -1)

      if ctx.read(log.root, "latest") < partitionId then
        isNewPart = true
      end
    end

    -- set up inmem partition state
    partition = {
      root    = ctx.mkdirp(log.root, partitionId),
      horizon = tonumber(ctx.read(log.root, partitionId, "horizon")),
      latest  = tonumber(ctx.read(log.root, partitionId, "latest")) or -1,
    }
    log.parts[partitionId] = partition
  end

  -- store using next ID from partition
  local nextId = ""..(partition.latest + 1)
  ctx.store(partition.root, nextId, entry)
  ctx.store(partition.root, "latest", nextId)
  partition.latest = nextId
  ctx.log("Wrote message", nextId, "into", partitionId, "for", log.root)

  -- update log to use new partition, if it was new
  if isNewPart then
    ctx.store(log.root, "latest", partitionId)
  end

  -- return the composite message id
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
local serverLog   = {
  root    = ctx.mkdirp(persist, "server-log"),
  parts   = {},
}
local mentionLog  = {
  root    = ctx.mkdirp(persist, "mention-log"),
  parts   = {},
}
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
      log     = {
        root  = ctx.mkdirp(channelsCtx, name, "log"),
        parts = {},
      },
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
      log     = {
        root  = ctx.mkdirp(queriesCtx, name, "log"),
        parts = {},
      },
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

-- Helpers to 'build up' a block of lines and eventually store them as one event
function startPartial(name, paramNum)
  return function(msg)
    ctx.store(state, name, msg.params[paramNum])
    return false -- don't checkpoint yet
  end
end
function appendPartial(name, paramNum, multi)
  return function(msg)
    local partial = ctx.read(state, name)
    if partial ~= "" then partial = partial.."\n" end

    if multi then
      -- Capture every part, tab-seperated
      local parts = {}
      local minParam = tonumber(paramNum)
      for idx, val in pairs(msg.params) do
        num = tonumber(idx)
        if num > minParam then parts[num-minParam] = val end
      end

      local line = msg.params[paramNum]
      for _, val in ipairs(parts) do
        line = line.."\t"..val
      end
      ctx.store(state, name, partial..line)

    else
      ctx.store(state, name, partial..msg.params[paramNum])
    end
    return false -- don't checkpoint yet
  end
end
function commitPartial(name, paramNum, label)
  return function(msg)
    local partial = ctx.read(state, name)
    ctx.unlink(state, name)
    if paramNum then
      if partial ~= "" then partial = partial.."\n" end
      partial = partial..msg.params[paramNum]
    end

    local params = {["1"] = label or msg.command}
    if paramNum == "3" then
      params["2"] = msg.params["2"]
    end

    -- write and checkpoint final block
    -- msg["prefix-name"] is probably the server, but does it matter?
    writeToLog(serverLog, {
        timestamp = msg.timestamp,
        command = "BLOCK",
        sender = msg["prefix-name"],
        params = params,
        text = partial,
      })
    return true
  end
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

      --[[
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
      ]]--

      -- TODO: find better home/conditional for such commands
      if msg.params["2"] == "!coinbase" and ctx.read(persist, "current-nick") == "danopia" then
        ctx.log("Responding to !coinbase command from", msg["prefix-name"], "in", msg.params["1"])
        data = ctx.invoke("session", "drivers", "coinbase-api-client", "fetch-prices", nil)

        local resp = "==> Converted to "..ctx.read(data, "currency")
        local prices = ctx.enumerate(data, "prices")
        for _, base in ipairs(prices) do
          local price = ctx.read(data, "prices", base.name)
          resp = resp..", "..(base.name).." is "..price
        end

        sendMessage("PRIVMSG", {
            ["1"] = msg.params["1"],
            ["2"] = resp,
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
      if words[1] == "VERSION" then
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
      writeToLog(serverLog, msg)
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

  -- initial post-reg state burst from server
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
  ["004"] = function(msg) -- RPL_MYINFO server compile config
    ctx.store(persist, "server-hostname", msg.params["2"])
    ctx.store(persist, "server-software", msg.params["3"])
    ctx.store(persist, "avail-user-modes", msg.params["4"])
    ctx.store(persist, "avail-chan-modes", msg.params["5"])
    ctx.store(persist, "paramed-chan-modes", msg.params["6"])
    ctx.store(persist, "supported", {})
    return writeToServerLog(msg)
  end,
  ["005"] = function(msg) -- RPL_MYINFO server limits/settings
    local paramCount = 0
    for _ in pairs(msg.params) do paramCount = paramCount + 1 end
    for key, raw in pairs(msg.params) do
      local idx = tonumber(key)
      if idx ~= 1 and idx ~= paramCount then
        local parts = ctx.splitString(raw, "=")
        ctx.store(persist, "supported", parts[1], parts[2] or "yes")
      end
    end
    return writeToServerLog(msg)
  end,

  ["042"] = writeToServerLog, -- RPL_YOURID [Mozilla]
  ["251"] = writeToServerLog, -- RPL_LUSERCLIENT online users
  ["252"] = writeToServerLog, -- RPL_LUSEROP online operators
  ["253"] = writeToServerLog, -- RPL_LUSERUNKNOWN "unknown" connections
  ["254"] = writeToServerLog, -- RPL_LUSERCHANNELS channels made
  ["255"] = writeToServerLog, -- RPL_LUSERME local clients
  ["265"] = writeToServerLog, -- RPL_LOCALUSERS local users
  ["266"] = writeToServerLog, -- RPL_GLOBALUSERS global users
  ["263"] = writeToServerLog, -- RPL_TRYAGAIN - command, then text - rate limiting on freenode
  ["250"] = writeToServerLog, -- RPL_GLOBALUSERS connection record

  ["221"] = function(msg) -- RPL_UMODEIS modes [params]
    ctx.store(persist, "umodes", msg.params["2"])
    writeToServerLog(msg)
    return true
  end,

  ["281"] = writeToServerLog, -- RPL_ACCEPTLIST - nick - from /accept *
  ["282"] = writeToServerLog, -- RPL_ENDOFACCEPT - from /accept *

  -- https://www.alien.net.au/irc/irc2numerics.html

  ["302"] = writeToServerLog, -- RPL_USERHOST
  ["305"] = writeToServerLog, -- RPL_UNAWAY flavor - from /away
  ["306"] = writeToServerLog, -- RPL_NOWAWAY flavor - from /away
  ["303"] = writeToServerLog, -- RPL_ISON list,of,names - from /ison
  ["351"] = writeToServerLog, -- RPL_VERSION ... - from /version
  ["391"] = writeToServerLog, -- RPL_TIME server time - from /time

  -- Freenode sends this for cloaks too
  -- If it's resent while in-channel, it means others saw a "Changing Host" bounce
  -- TODO: show that bounce ourselves to keep timeline consistent
  ["396"] = writeToServerLog, -- RPL_HOSTHIDDEN [Mozilla]

  ["304"] = writeToServerLog, -- RPL_TEXT - Mozilla uses this to give syntax help, e.g. `/whois`
  ["401"] = writeToServerLog, -- ERR_NOSUCHNICK missing recipient error
  ["403"] = writeToServerLog, -- ERR_NOSUCHCHANNEL
  ["404"] = writeToServerLog, -- ERR_CANNOTSENDTOCHAN
  ["411"] = writeToServerLog, -- ERR_NORECIPIENT no recipient error
  ["421"] = writeToServerLog, -- ERR_UNKNOWNCOMMAND no such command, or it's hidden
  ["433"] = writeToServerLog, -- ERR_NICKNAMEINUSE nickname in use - dialer handles this for us
  ["461"] = writeToServerLog, -- ERR_NEEDMOREPARAMS -- client failure
  ["462"] = writeToServerLog, -- ERR_ALREADYREGISTERED
  ["473"] = writeToServerLog, -- ERR_INVITEONLYCHAN
  ["477"] = writeToServerLog, -- ERR_NEEDREGGEDNICK
  ["435"] = writeToServerLog, -- Freenode: Cannot change nickname while banned on channel

  ["481"] = writeToServerLog, -- ERR_NOPRIVILEGES - just flavor - from /map on freenode
  ["482"] = function(msg) -- ERR_CHANOPRIVSNEEDED - chan, flavor
    local chan = getChannel(msg.params["2"])
    writeToLog(chan.log, msg)
    return true
  end,

  -- WHOIS stuff - should be bundled together tbh
  ["301"] = appendPartial("whois-partial", "3", true), -- RPL_AWAY - nick, message
  ["307"] = appendPartial("whois-partial", "3", true), -- RPL_WHOISREGNICK - nick, flavor - is registered - mozilla
  ["311"] = appendPartial("whois-partial", "3", true), -- RPL_WHOISUSER - nick, user, host, '*', realname
  ["312"] = appendPartial("whois-partial", "3", true), -- RPL_WHOISSERVER - nick, server, serverinfo
  ["313"] = appendPartial("whois-partial", "3", true), -- RPL_WHOISOPERATOR - nick, privs
  ["314"] = appendPartial("whois-partial", "3", true), -- RPL_WHOWASUSER - nick, user, host, '*', realname
  ["317"] = appendPartial("whois-partial", "3", true), -- RPL_WHOISIDLE - nick, seconds, flavor
  ["671"] = appendPartial("whois-partial", "3", true), -- RPL_WHOISSECURE - nick, type[, flavor]
  ["319"] = appendPartial("whois-partial", "3", true), -- RPL_WHOISCHANNELS - nick, channels (w/ mode prefix)
  ["330"] = appendPartial("whois-partial", "3", true), -- RPL_WHOISACCOUNT - nick, account, flavor
  ["378"] = appendPartial("whois-partial", "3", true), -- RPL_WHOISHOST - nick, flavor w/ host
  ["379"] = appendPartial("whois-partial", "3", true), -- RPL_WHOISMODES - nick, flavor - unreal/mozilla
  ["318"] = commitPartial("whois-partial", "3", "whois"), -- RPL_ENDOFWHOIS - nick, flavor

  ["324"] = writeToServerLog, -- RPL_CHANNELMODEIS - channel, modes, params... - from /mode
  ["329"] = writeToServerLog, -- RPL_CREATIONTIME - channel, epoch seconds - sent with /mode resp

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
  ["375"] = startPartial("motd-partial", "2"), -- RPL_MOTDSTART motd header
  ["372"] = appendPartial("motd-partial", "2"), -- RPL_MOTD motd body
  ["376"] = commitPartial("motd-partial", "2", "motd"), -- RPL_ENDOFMOTD motd complete

  -- server info
  ["371"] = appendPartial("info-partial", "2"), -- RPL_INFO info body -- there is no Start from freenode
  ["374"] = commitPartial("info-partial", "2", "info"), -- RPL_ENDOFINFO info complete

  -- stats blocks, from /stats, records numerics too
  ["211"] = appendPartial("stats-partial", "2", true), -- RPL_STATSLINKINFO - linkname sendq sentmsg sendbytes recvmsg recvdbytes timeopen
  ["212"] = appendPartial("stats-partial", "2", true), -- RPL_STATSCOMMANDS - command count [bytect remotect]
  ["213"] = appendPartial("stats-partial", "2", true), -- RPL_STATSCLINE - C host * name port class
  ["214"] = appendPartial("stats-partial", "2", true), -- RPL_STATSNLINE - N host * name port class
  ["215"] = appendPartial("stats-partial", "2", true), -- RPL_STATSILINE - I host * name port class
  ["216"] = appendPartial("stats-partial", "2", true), -- RPL_STATSKLINE - K host * username port class
  ["217"] = appendPartial("stats-partial", "2", true), -- RPL_STATSQLINE
  ["218"] = appendPartial("stats-partial", "2", true), -- RPL_STATSYLINE - Y class pingfreq conenctfreq maxsendq
  ["219"] = appendPartial("stats-partial", "2", true), -- RPL_ENDOFSTATS - query flavor
  ["249"] = appendPartial("stats-partial", "2", true), -- RPL_STATSULINE maybe? freenode oper list
  ["219"] = commitPartial("stats-partial", "3", "stats"), -- RPL_ENDOFSTATS complete

  -- links block
  ["364"] = appendPartial("links-partial", "2"), -- RPL_LINKS info body -- there is no Start
  ["365"] = commitPartial("links-partial", nil, "links"), -- RPL_ENDOFLINKS complete

  -- unreal module list block
  ["702"] = appendPartial("modules-partial", "2"), -- RPL_MODLIST ... -- there is no Start
  ["703"] = commitPartial("modules-partial", nil, "module-list"), -- RPL_ENDOFMODLIST complete

  -- server help - e.g. freenode
  ["704"] = startPartial("help-partial", "3"), -- RPL_HELPSTART
  ["705"] = appendPartial("help-partial", "3"), -- RPL_HELPTXT
  ["706"] = commitPartial("help-partial", "3", "help"), -- RPL_ENDOFHELP
  ["524"] = writeToServerLog, -- help not found, freenode nonstandard - help-arg then message

  -- UNREAL/mozilla server help - NONSTANDARD - partial ends with no notice
  ["290"] = appendPartial("help-partial", "2"), -- RPL_HELPHDR
  ["292"] = function(msg) -- RPL_HELPTXT
    if msg.params["2"] == "*** End of HELPOP" then
      return commitPartial("help-partial", "2", "help")(msg)
    else
      return appendPartial("help-partial", "2")(msg)
    end
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

  -- channel WHO functionality. maybe non-channel too?
  -- TODO: 354 is used when a % format is given
  ["352"] = function(msg) -- RPL_WHOREPLY - me, chan, user, host, server, nick, 'H', '0 '..realname
    local chan = getChannel(msg.params["2"])
    local prev = ctx.readDir(chan.members, msg.params["6"]) or {}

    ctx.store(chan.members, msg.params["6"], {
        modes = prev["modes"],
        nick = msg.params["6"],
        user = msg.params["3"],
        host = msg.params["4"],
        server = msg.params["5"],
        realname = string.sub(msg.params["8"], 3),
    })
    return true
  end,
  ["315"] = function(msg) -- RPL_ENDOFWHO - me, chan, flavor
    local chan = getChannel(msg.params["2"])
    writeToLog(chan.log, msg)
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

    elseif message.source ~= "client" or message.command == 'PRIVMSG' or message.command == 'NOTICE' or message.command == 'CTCP' or message.command == 'CTCP_ANSWER' then

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
  if pingCounter > 240 then
    sendMessage("PING", {
        ["1"] = "maintain-wire "..ctx.timestamp(),
      })
    healthyWire = wireIsHealthy()
    pingCounter = 1
  end

  -- Sleep a sec
  ctx.sleep(250)
end

if ctx.read(state, "status") == "Ready" then
  ctx.store(state, "status", "Completed at "..ctx.timestamp())
end
