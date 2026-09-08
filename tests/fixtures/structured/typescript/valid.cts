import dependency = require('./dependency.js');

function helper(): number {
  return dependency.value;
}

export = { rebuilt: helper };
