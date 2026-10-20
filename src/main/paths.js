'use strict';
const path = require('path');

function makePaths(root) {
  const shared = path.join(root, 'shared');
  return {
    root,
    shared,
    versions: path.join(shared, 'versions'),
    libraries: path.join(shared, 'libraries'),
    assets: path.join(shared, 'assets'),
    runtime: path.join(shared, 'runtime'),
    instances: path.join(root, 'instances'),
    logs: path.join(root, 'logs'),
    settings: path.join(root, 'settings.json'),
    profiles: path.join(root, 'profiles.json'),
    accounts: path.join(root, 'accounts.json')
  };
}
module.exports = { makePaths };
