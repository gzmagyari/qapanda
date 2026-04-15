try {
  module.exports = require('./src/settings-store');
} catch {
  module.exports = require('../src/settings-store');
}
