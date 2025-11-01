// Minimal stub for 'unix-dgram' on Windows
module.exports = {
  createSocket() {
    return {
      on(){}, send(){}, close(){}
    };
  }
};
