const { PathFragment } = require('@dustjs/skylink');
// const { html, safeHtml, stripIndent } = require('common-tags');

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { FieldValue } = admin.firestore;
const db = admin.firestore();

exports.serveFile = functions.https.onRequest(async (request, response) => {
  if (request.method !== 'GET') return response.status(405)
    .send(`Only GET works here`);
  try {

    const path = PathFragment.parse(request.path);
    const match = path.matchWith('/files/id/:id/:*rest');
    if (!match.ok) return response.status(404)
      .send(`BUG: Files path didn't match`);
    const uploadId = match.params.get('id');
    const filePath = match.params.get('rest').join('/');
    const fileName = match.params.get('rest').slice(-1)[0];

    // Perform database lookup
    const querySnap = await db.collectionGroup(`files uploads`)
      .where('id', '==', uploadId).get();
    if (querySnap.size < 1) return response.status(404)
      .send(`404: File not found`);
    if (querySnap.size > 1) return response.status(500)
      .send(`BUG: File ID is conflicting`);
    const docSnap = querySnap.docs[0];
    console.log(JSON.stringify(docSnap.data()));

    // Extract the document a bit
    const url = docSnap.get('url');
    if (!url.startsWith('gs://')) throw new Error(
      `File URL wasn't google storage`);
    const urlPart = url.slice(5);
    const slashIdx = urlPart.indexOf('/');
    const file = admin.storage()
      .bucket(urlPart.slice(0, slashIdx))
      .file(urlPart.slice(slashIdx + 1));
    // console.log('file:', file);

    const [signedUrl] = await file.getSignedUrl({
      virtualHostedStyle: true,
      action: 'read',
      expires: +new Date() + (1000 * 60 * 60), // an hour
    })
    // console.log('resp:', resp);

    // response.set('Content-Type', docSnap.get(''));
    response.set('Location', signedUrl);
    response.status(307);//.send(JSON.stringify(resp, null, 2));
    response.send(signedUrl);
    // response.set('Content-Type', 'text/plain; charset=utf-8');

    console.log('Recording view...');
    await docSnap.ref.update({
      views: FieldValue.increment(1),
    });

  } catch (err) {
    console.log(err.stack);
    response.status(500).send(err.message);
  }
});
