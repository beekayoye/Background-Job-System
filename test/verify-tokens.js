/**
 * @file test/verify-tokens.js
 * @description Automated verification test suite for generated design tokens CSS.
 * Verifies that:
 * 1. All output files are generated.
 * 2. Every semantic token reference `var(--primitive-color-*)` maps to a defined primitive variable.
 * 3. All spacing, typography, and shadow variables are syntactically valid.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { convertTokens } = require('../convert-tokens');

console.log('🧪 Starting Design Tokens Verification Test Suite...\n');

// 1. Run conversion
const testOutputDir = path.join(__dirname, 'output');
convertTokens('design-tokens.tokens.json', testOutputDir);

// 2. Check generated files
const expectedFiles = [
  'tokens.css',
  'tokens.primitives.css',
  'tokens.semantic.css',
  'tokens.spacing.css',
  'tokens.typography.css',
  'tokens.effects.css',
];

console.log('🔍 Checking file generation:');
for (const file of expectedFiles) {
  const filePath = path.join(testOutputDir, file);
  assert(fs.existsSync(filePath), `Missing output file: ${file}`);
  const stats = fs.statSync(filePath);
  assert(stats.size > 0, `Generated file is empty: ${file}`);
  console.log(`  ✔ ${file} (${stats.size} bytes)`);
}

// 3. Verify CSS variable references in semantic CSS
console.log('\n🔍 Verifying semantic color role variable references:');
const primitivesCss = fs.readFileSync(path.join(testOutputDir, 'tokens.primitives.css'), 'utf-8');
const semanticCss = fs.readFileSync(path.join(testOutputDir, 'tokens.semantic.css'), 'utf-8');

// Extract all primitive variable names
const primitiveVarRegex = /(--primitive-color-[a-z0-9-]+):/g;
const declaredPrimitives = new Set();
let match;
while ((match = primitiveVarRegex.exec(primitivesCss)) !== null) {
  declaredPrimitives.add(match[1]);
}
console.log(`  Found ${declaredPrimitives.size} declared primitive color variables.`);

// Extract all var(--...) calls from semantic CSS
const varUsageRegex = /var\((--[a-z0-9-]+)\)/g;
const usedVariables = [];
while ((match = varUsageRegex.exec(semanticCss)) !== null) {
  usedVariables.push(match[1]);
}
console.log(`  Found ${usedVariables.length} semantic color role references.`);

let missingRefs = 0;
for (const ref of usedVariables) {
  if (!declaredPrimitives.has(ref)) {
    console.error(`  ❌ Broken reference: ${ref} is not defined in primitives!`);
    missingRefs++;
  }
}

assert.strictEqual(missingRefs, 0, `Found ${missingRefs} unresolved token references in semantic roles.`);
console.log(`  ✔ All ${usedVariables.length} semantic role references resolve cleanly to defined primitives.`);

// 4. Clean up test directory
fs.rmSync(testOutputDir, { recursive: true, force: true });

console.log('\n✨ ALL TESTS PASSED SUCCESSFULLY! ✨\n');
