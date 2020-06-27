import moment from 'moment'

function getEnumerationStrings(enumer) {
  const dict = Object.create(null);
  for (const entry of enumer) {
    if (entry.Type !== 'String') continue;
    dict[entry.Name] = entry.StringValue || '';
  }
  return dict;
}

const subPathAll = (list, path) => list
  .map(x => x.subPath(path));


async function copyLogPartition(srcPart, dstPart) {
  const [srcLatest, dstLatest] = await Promise.all([srcPart, dstPart].map(x => x
    .subPath('/latest').readString().then(y => y ? parseInt(y) : y)));
  if (!srcLatest) return false;
  if (srcLatest === dstLatest) {
    console.log('Partition', dstPart.path, 'already up to date with', dstLatest, 'entries');
    return true;
  }
  if (dstLatest) throw new Error(
    `TODO: log ${dstPart.path} is partially outdated`);

  const srcHorizon = parseInt(await srcPart.subPath('/horizon').readString());
  await dstPart.subPath('/horizon').storeString(`${srcHorizon}`);

  for (let idx = srcHorizon; idx <= srcLatest; idx++) {
    const [srcEntry, dstEntry] = subPathAll([srcPart, dstPart], `/${idx}`);
    const entryLiteral = await srcEntry.enumerateToLiteral({Depth: 5});
    console.log('Writing', (entryLiteral.Children.find(x => x.Name === 'command')||{}).StringValue, 'to', dstEntry.path);
    await dstEntry.storeLiteral(entryLiteral);
  }

  await dstPart.subPath('/latest').storeString(`${srcLatest}`);
  console.log('Done with', dstPart.path, 'log');
  return true;
}

const partFmt = 'YYYY-MM-DD';
async function syncWholeLog(srcRoot, dstRoot) {
  const [srcLatest, dstLatest] = await Promise.all([srcRoot, dstRoot].map(x => x
    .subPath('/latest').readString().then(y => y ? moment(y, partFmt) : y)));
  // if (dstLatest) throw new Error(
  //   `TODO: log ${dstRoot.path} is partially created already ${srcLatest}`);

  const srcHorizon = moment(await srcRoot.subPath('/horizon').readString(), partFmt);
  await dstRoot.subPath('/horizon').storeString(srcHorizon.format(partFmt));

  for (let cursor = (dstLatest || srcHorizon); cursor <= srcLatest; cursor.add(1, 'day')) {
    const partId = cursor.format(partFmt);
    if (cursor < dstLatest) {
      console.log('Part', partId.path, 'is already outdated on dest, skipping');
    }
    if (await copyLogPartition(...subPathAll([srcRoot, dstRoot], `/${partId}`))) {
      await dstRoot.subPath('/latest').storeString(partId);
    }
  }

  console.log('Done with', dstRoot.path, 'log');
}


export async function runMigration({source, dest}, networkName) {
  if (!networkName) throw new Error(`--network=<name> is required`);
  console.log('Checking config for', networkName, '...');

  const [srcPersist, dstPersist] = subPathAll([source, dest],
    `/persist/irc/networks/${networkName}`);

  await syncWholeLog(...subPathAll([srcPersist, dstPersist], `/server-log`));
  await syncWholeLog(...subPathAll([srcPersist, dstPersist], `/mention-log`));

  const srcData = await srcPersist.enumerateChildren({Depth: 1});
  const srcSupported = await srcPersist.subPath('/supported').enumerateChildren({Depth: 1});
  const srcFields = getEnumerationStrings(srcData);

  const serverFields = [
    'avail-chan-modes', 'avail-user-modes', 'current-nick',
    'latest-seen', 'paramed-chan-modes', 'server-hostname', 'server-software',
    'umodes',
  ];
  await dstPersist.storeFolder([
    ...srcData.filter(x => serverFields.includes(x.Name)),
    { Name: 'supported', Type: 'Folder', Children: srcSupported },
  ]);

  await dest.subPath(`/persist/irc/wires/${networkName}`).storeFolder([
    { Name: 'checkpoint', Type: 'String', StringValue: srcFields['wire-checkpoint']},
    { Name: 'wire-uri', Type: 'String', StringValue: srcFields['wire-uri'].replace('modem2.devmode.cloud', 'modem2-proxy.wg69.svc.cluster.local')},
  ]);

  for (const channel of (await srcPersist.subPath(`/channels`).enumerateToLiteral({Depth: 2})).Children) {
    const [srcPath, dstPath] = subPathAll([srcPersist, dstPersist], `/channels/${channel.Name}`);

    const topicLiteral = await srcPath.subPath('/topic').enumerateToLiteral({Depth: 5});
    const membersLiteral = await srcPath.subPath('/membership').enumerateToLiteral({Depth: 5});
    await dstPath.storeFolder([
      ...channel.Children.filter(x => x.Type === 'String'),
      { Name: 'topic', Type: 'Folder', Children: topicLiteral.Children },
      { Name: 'members', Type: 'Folder', Children: membersLiteral.Children },
    ]);
    await syncWholeLog(...subPathAll([srcPath, dstPath], `/log`));
  }

  for (const channel of (await srcPersist.subPath(`/queries`).enumerateToLiteral({Depth: 2})).Children) {
    const [srcPath, dstPath] = subPathAll([srcPersist, dstPersist], `/queries/${channel.Name}`);
   await dstPath.storeFolder([
      ...channel.Children.filter(x => x.Type === 'String'),
    ]);
    await syncWholeLog(...subPathAll([srcPath, dstPath], `/log`));
  }

  const sourceCfg = await source.subPath(`/config/irc/networks/${networkName}`).enumerateToLiteral({Depth: 5});
  const channelCfgs = sourceCfg.Children.find(x => x.Name === 'channels');
  if (channelCfgs.Children.length > 0 && channelCfgs.Children[0].Type === 'String') {
    // redo the channel list as a map of options instead of a simple 'list' of names
    const channelSet = new Set(channelCfgs.Children.map(x => x.StringValue));
    channelCfgs.Children = Array.from(channelSet)
      .map(x => ({ Name: x, Type: 'Folder', Children: [
        { Name: 'auto-join', Type: 'String', StringValue: 'yes' },
      ]}));
  }
  // disable autoconnect to avoid breaking the migration process
  sourceCfg.Children.find(x => x.Name === 'auto-connect').StringValue = 'no';
  await dest.subPath(`/config/irc/networks/${networkName}`).storeLiteral(sourceCfg);

  console.log()
}
