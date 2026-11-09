// One coordinator per proxy. Only identical artifact/context requests share a
// scan; each request retains its own quarantined snapshot until authorization.
export function createScanCoordinator({ concurrency = 4, maxPending = 64, queueTimeoutMs = 20000 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32 ||
      !Number.isInteger(maxPending) || maxPending < 0 || maxPending > 1024 ||
      !Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 1) throw new Error('Invalid scan coordinator limits');
  const pending = [];
  const inFlight = new Map();
  let active = 0;

  function start(job) {
    clearTimeout(job.timer);
    active++;
    const finish = () => {
      inFlight.delete(job.key);
      active--;
      if (pending.length) start(pending.shift());
    };
    Promise.resolve().then(job.scan).then(result => {
      finish(); job.resolve(result);
    }, error => {
      finish(); job.reject(error);
    });
  }

  return {
    run(key, scan) {
      if (inFlight.has(key)) return inFlight.get(key);
      if (active >= concurrency && pending.length >= maxPending) {
        return Promise.reject(Object.assign(new Error('Scan queue is full; artifact remains unapproved. Retry later.'), { code: 'PKGXRAY_SCAN_BUSY' }));
      }
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const job = { key, scan, resolve, reject };
      inFlight.set(key, promise);
      if (active < concurrency) start(job);
      else {
        pending.push(job);
        job.timer = setTimeout(() => {
          pending.splice(pending.indexOf(job), 1);
          inFlight.delete(key);
          reject(Object.assign(new Error('Scan queue wait timed out; artifact remains unapproved. Retry later.'), { code: 'PKGXRAY_SCAN_BUSY' }));
        }, queueTimeoutMs);
      }
      return promise;
    }
  };
}
