'use strict';

// Compose service identifiers, not the stricter lowercase project-name syntax.
// Matching is deliberately exact and case-sensitive; this is never a glob.
const serviceName = value => typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value);
module.exports = { serviceName };
