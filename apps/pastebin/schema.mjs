// This is a DataTree schema
// For more info, visit https://www.npmjs.com/package/@dustjs/data-tree

export const metadata = {
  AppName: 'Pastebin',
  Author: 'Daniel Lamando',
  License: 'MIT',
};
export function builder(El, addRoot) {

  addRoot(new El.AppRegion('config', {
    '/prefs': new El.Document({
      '/userstyle.css': new El.Blob('text/css', 'utf-8'),
    }),
  }));

  addRoot(new El.AppRegion('persist', {

    '/pastes': new El.Collection({
      '/title': String,
      '/filename': String,
      '/created': Date,
      '/language': String,
      '/data': new El.Blob('text/plain', 'utf-8'),
      // '/revisions': new El.Collection({
      // }),
    }),

    // '/uploads': new El.Collection({
    //   '/title': String,
    //   '/filename': String,
    //   '/created': Date,
    //   '/mime-type': String,
    //   '/data': new El.Blob('application/octet-stream'),
    // }),

  }));

}
