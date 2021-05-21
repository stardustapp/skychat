#!/usr/bin/env -S deno run --allow-net=firestore.googleapis.com --allow-run=kubectl --allow-read=.
import { ServiceAccount } from "https://crux.land/5D1UrM#google-service-account@v2";

const credential = await ServiceAccount.readFromFile("stardust-skychat-f27a8e2eef78.json");
// const token = await credential.issueToken("https://www.googleapis.com/auth/datastore");
const token = { access_token: await credential.selfSignToken("https://firestore.googleapis.com/") };

import { autoDetectClient } from 'https://deno.land/x/kubernetes_client@v0.2.4/mod.ts';
import { CoreV1Api } from "https://deno.land/x/kubernetes_apis@v0.3.1/builtin/core@v1/mod.ts";

const kubernetes = await autoDetectClient();
const coreApi = new CoreV1Api(kubernetes);

const allPodIps = new Set<string>(await coreApi.getPodListForAllNamespaces().then(list =>
  list.items.flatMap(x => x.status?.podIP ? [x.status?.podIP] : [])));
if (allPodIps.size < 10) throw new Error(
  `Cowardly failing because I only saw ${allPodIps.size} pod IPs`);

const docs = await fetch(
  'https://firestore.googleapis.com/v1/projects/stardust-skychat/databases/(default)/documents:runQuery', {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        select: {
          fields: [{
            fieldPath: '__name__',
          }, {
            fieldPath: 'wireUri',
          }],
        },
        from: [{
          collectionId: 'irc wires',
          allDescendants: true, // CollectionGroup query
        }],
        where: { unaryFilter: {
          op: 'IS_NOT_NULL',
          field: {
            fieldPath: 'wireUri',
          },
        } },
      },
//      readTime: new Date().toISOString(),
    }),
    headers: {
      authorization: `Bearer ${token.access_token}`,
    },
  }).then(x => x.json());

// console.log(docs);
for (const {document} of docs) {
  const wireUri = document.fields.wireUri.stringValue as string;
  const wireHost = wireUri.split('/')[2].split(':')[0];

  if ((wireHost.startsWith('10.8.') || wireHost.startsWith('10.10.')) && !allPodIps.has(wireHost)) {
    console.log('Deleting', document.name, '@', wireHost, '...');
    await fetch('https://firestore.googleapis.com/v1/'+document.name, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token.access_token}`,
      },
    });
  } else {
    console.log('Wire host', wireHost, 'looks reasonable');
  }
}
