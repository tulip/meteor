Package.describe({
  name: "babel-compiler",
  summary: "Parser/transpiler for ECMAScript 2015+ syntax",
  version: '7.10.5',
});

Npm.depends({
  '@meteorjs/babel': 'https://github.com/tulip/meteor/releases/download/updated-meteor-babel/meteorjs-babel-7.18.4.tgz',
  'json5': '2.2.3'
});

Package.onUse(function (api) {
  api.use('ecmascript-runtime', 'server');
  api.use('modern-browsers');

  api.addFiles([
    'babel.js',
    'babel-compiler.js',
    'versions.js',
  ], 'server');

  api.export('Babel', 'server');
  api.export('BabelCompiler', 'server');
});
