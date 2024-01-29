/* eslint-disable */
module.exports = function (wallaby) {
  return {
    env: {
      type: 'node',
    },
    symlinkNodeModules: true,
    workers: { restart: true },
    files: ['packages/dilithium5/package.json', 'packages/dilithium5/src/**/*.js'],
    tests: ['packages/dilithium5/test/**/*.js'],
    testFramework: 'mocha',
  };
};
