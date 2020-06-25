function nullIfNotFound(err) {
  if (err.message.includes('Path not found')) return null;
  throw err;
}

function getEnumerationStrings(enumer) {
  const dict = Object.create(null);
  for (const entry of enumer) {
    if (entry.Type !== 'String') continue;
    dict[entry.Name] = entry.StringValue || '';
  }
  return dict;
}

function getEnumFolders(enumer) {
  const ary = new Array;
  let currentChildren = null;
  for (const entry of enumer) {
    if (entry.Name.includes('/')) {
      entry.Name = entry.Name.slice(entry.Name.indexOf('/')+1);
      currentChildren.push(entry);
    } else if (entry.Type === 'Folder') {
      entry.Children = currentChildren = new Array;
      ary.push(entry);
    }
  }
  return ary;
}

export async function runMigration(api, networkName) {
  if (!networkName) throw new Error(`--network=<name> is required`);
  console.log('Checking config for', networkName, '...');

  const enumeratePath = (Path, { Depth=1 }={}) => api
    .performOperation({ Op: 'enumerate', Path, Depth })
    .then(x => x.Children.filter(x => x.Name))
    .catch(nullIfNotFound);

  const storeFolder = (Path, Children=[]) => api
    .performOperation({ Op: 'store',
      Dest: Path,
      Input: { Type: 'Folder', Children },
    });

  // const sourceCfg = await enumeratePath(`/source/config/irc/networks/${networkName}`, {Depth: 2});
  // const destCfg = await enumeratePath(`/dest/config/networks/${networkName}`, {Depth: 2});

  const srcPersistPath = `/source/persist/irc/networks/${networkName}`;
  const dstPersistPath = `/dest/persist/irc/networks/${networkName}`;

  const srcData = await enumeratePath(srcPersistPath, {Depth: 1});
  const srcSupported = await enumeratePath(srcPersistPath+'/supported', {Depth: 1});
  const srcFields = getEnumerationStrings(srcData);

  const serverFields = [
    'avail-chan-modes', 'avail-user-modes', 'current-nick',
    'latest-seen', 'paramed-chan-modes', 'server-hostname', 'server-software',
    'umodes',
  ];
  await storeFolder(`${dstPersistPath}`, [
    ...srcData.filter(x => serverFields.includes(x.Name)),
    { Name: 'supported', Type: 'Folder', Children: srcSupported },
  ]);

  await storeFolder(`/dest/persist/irc/wires/${networkName}`, [
    { Name: 'checkpoint', Type: 'String', StringValue: srcFields['wire-checkpoint']},
    { Name: 'wire-uri', Type: 'String', StringValue: srcFields['wire-uri']},
  ]);

  for (const channel of getEnumFolders(await enumeratePath(`${srcPersistPath}/channels`, {Depth: 2}))) {
    // console.log(channel);
    const topicChildren = await enumeratePath(`${srcPersistPath}/channels/${channel.Name}/topic`, {Depth: 1});
    const membersChildren = getEnumFolders(await enumeratePath(`${srcPersistPath}/channels/${channel.Name}/membership`, {Depth: 2}));
    await storeFolder(`${dstPersistPath}/channels/${channel.Name}`, [
      ...channel.Children.filter(x => x.Type === 'String'),
      { Name: 'topic', Type: 'Folder', Children: topicChildren },
      { Name: 'members', Type: 'Folder', Children: membersChildren },
    ]);
  }

  console.log()
}
