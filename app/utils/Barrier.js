module.exports = function(fn) {
  return async function() {
    const self = this;
    const args = arguments;
    async function exec() {
      try {
        return await fn.apply(self, args);
      }
      finally {
        const next = fn.__barrier.shift();
        if (next) {
          setImmediate(next);
        }
        else {
          fn.__barrier = null;
        }
      }
    }
    if (!fn.__barrier) {
      fn.__barrier = [];
      return await exec();
    }
    else {
      return new Promise((resolve, reject) => {
        fn.__barrier.push(async () => {
          try {
            resolve(await exec());
          }
          catch (e) {
            reject(e);
          }
        });
      });
    }
  }
}
