// This is a DataTree schema
// For more info, visit https://www.npmjs.com/package/@dustjs/data-tree

export const metadata = {
  AppName: 'Files',
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

    '/uploads': new El.Collection({
      '/id': Symbol.for('doc id'),
      '/filename': String,
      '/mime-type': String,
      '/size': Number,
      '/modified': Date,
      '/uploaded': Date,
      '/url': String,
      '/views': Number,
    }),

  }));

}
