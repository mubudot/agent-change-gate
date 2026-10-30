// Offline manifest check against the JSON schema shipped inside @forge/cli
// (forge lint needs a login). Usage: FORGE_CLI_DIR=<dir containing node_modules/@forge/cli> node scripts/validate-manifest.cjs
const path = require('node:path');
const fs = require('node:fs');
const base = path.resolve(process.env.FORGE_CLI_DIR || '.', 'node_modules/@forge/cli/node_modules');
const Ajv = require(path.join(base, 'ajv'));
const yaml = require(path.join(base, 'yaml'));
const schema = JSON.parse(fs.readFileSync(path.join(base, '@forge/manifest/out/schema/manifest-schema.json'), 'utf8'));
const manifest = yaml.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.yml'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const ok = ajv.validate(schema, manifest);
if (ok) console.log('manifest.yml: valid against bundled Forge manifest schema');
else { console.log(JSON.stringify(ajv.errors.slice(0, 30), null, 1)); process.exit(1); }
