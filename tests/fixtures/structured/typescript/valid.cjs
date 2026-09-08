const { value: dependency } = require('./dependency.js');

function helper() {
  return dependency;
}

exports.rebuilt = helper;
