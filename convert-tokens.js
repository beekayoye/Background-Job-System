/**
 * @file convert-tokens.js
 * @description Converts Figma / Design System tokens from JSON format (`design-tokens.tokens.json`)
 * into structured, maintainable CSS Custom Properties (Variables).
 *
 * Architecture & Color System Design:
 * -------------------------------------------------------------
 * 1. PRIMITIVE COLORS (`--primitive-color-*`):
 *    - Foundation color palettes (primary, secondary, tertiary, neutral, neutral-variant, error).
 *    - Key color groups and numerical tonal scales (0, 10, 20, ... 100).
 *    - IMPORTANT: These are internal foundations and MUST NOT be used directly in UI styling.
 *
 * 2. COLOR ROLES (`--color-*`):
 *    - Semantic tokens representing specific UI purposes (e.g., surface, on-surface, primary, error-container).
 *    - Directly reference primitive CSS variables via `var(--primitive-color-*)`.
 *    - UI components and application stylesheets MUST use ONLY these semantic color roles.
 *
 * 3. SPACING (`--spacing-*`):
 *    - Dimension scale tokens mapped to semantic sizing identifiers (none, xs, sm, md, base, lg, xl, 2xl).
 *
 * 4. TYPOGRAPHY (`--typography-*` & utility classes):
 *    - Type scale tokens covering display, headline, title, body, and label roles.
 *    - Generates atomic CSS properties and composable typography utility classes.
 *
 * 5. EFFECTS (`--effect-*`):
 *    - Elevation and shadow tokens mapped to CSS `box-shadow` values.
 */

const fs = require('fs');
const path = require('path');

/**
 * Configuration options for the converter
 */
const CONFIG = {
  defaultInput: 'design-tokens.tokens.json',
  defaultOutputDir: 'dist',
  baseFontSize: 16, // px for rem calculations
};

/**
 * Normalizes string keys into clean, kebab-case CSS variable identifiers
 * @param {string} str - Raw token name or path segment
 * @returns {string} - Kebab-cased identifier
 */
function toKebabCase(str) {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2') // split camelCase
    .replace(/([a-zA-Z])(\d+)/g, '$1-$2') // split letters and trailing numbers like primary100 -> primary-100
    .replace(/[\s_]+/g, '-') // convert spaces and underscores to hyphens
    .toLowerCase()
    .replace(/-+/g, '-') // collapse multiple hyphens
    .replace(/^-|-$/g, ''); // trim hyphens
}

/**
 * Converts a pixel number or string to a formatted pixel and optional rem value
 * @param {number|string} val - Numeric dimension value
 * @returns {string} - CSS dimension string (e.g. '16px')
 */
function formatDimension(val) {
  if (typeof val === 'number') {
    return val === 0 ? '0px' : `${val}px`;
  }
  return String(val);
}

/**
 * Resolves a token reference path (e.g. `{primitives colors.key color group.primary key color}`)
 * to its corresponding CSS variable name and internal key.
 *
 * @param {string} refString - The raw reference string from JSON
 * @returns {{ cssVar: string, pathKeys: string[] } | null}
 */
function parseTokenReference(refString) {
  if (!refString || typeof refString !== 'string') return null;
  const match = refString.match(/^\{(.+)\}$/);
  if (!match) return null;

  const fullPath = match[1];
  const pathParts = fullPath.split('.');

  // Construct CSS variable name based on category
  const category = pathParts[0].toLowerCase();
  const subCategory = pathParts[1] ? pathParts[1].toLowerCase() : '';
  const tokenName = pathParts[2] ? pathParts[2].toLowerCase() : '';

  if (category.includes('primitive')) {
    // Special naming for key color group vs tonal palettes
    if (subCategory.includes('key color')) {
      const cleanName = toKebabCase(tokenName.replace('key color', '').trim());
      return {
        cssVar: `--primitive-color-key-${cleanName}`,
        pathKeys: pathParts,
      };
    } else {
      // Palette scale (e.g. primary100 -> primary-100)
      const cleanPalette = toKebabCase(subCategory.replace('color palette', '').trim());
      const cleanToken = toKebabCase(tokenName);
      return {
        cssVar: `--primitive-color-${cleanToken}`,
        pathKeys: pathParts,
      };
    }
  }

  // Fallback generic variable generator
  const cleanSegments = pathParts.map(toKebabCase).filter(Boolean);
  return {
    cssVar: `--${cleanSegments.join('-')}`,
    pathKeys: pathParts,
  };
}

/**
 * Processes Primitive Color tokens
 * Generates `--primitive-color-*` variables
 *
 * @param {Object} primitivesGroup - The 'primitives colors' object from JSON
 * @returns {{ cssLines: string[], tokenMap: Map<string, string> }}
 */
function processPrimitiveColors(primitivesGroup) {
  const cssLines = [];
  const tokenMap = new Map();

  cssLines.push('  /* ==========================================================================');
  cssLines.push('     1. PRIMITIVE COLORS (Foundational Palettes)');
  cssLines.push('     DO NOT USE DIRECTLY IN UI COMPONENTS. Used only as color role references.');
  cssLines.push('     ========================================================================== */\n');

  for (const [groupName, groupContent] of Object.entries(primitivesGroup)) {
    const isKeyColor = groupName.toLowerCase().includes('key color');
    cssLines.push(`  /* Palette Group: ${groupName} */`);

    for (const [tokenName, tokenData] of Object.entries(groupContent)) {
      let varName;
      if (isKeyColor) {
        const cleanRole = toKebabCase(tokenName.replace('key color', '').trim());
        varName = `--primitive-color-key-${cleanRole}`;
      } else {
        varName = `--primitive-color-${toKebabCase(tokenName)}`;
      }

      const colorValue = tokenData.value;
      tokenMap.set(`${groupName}.${tokenName}`.toLowerCase(), varName);
      tokenMap.set(varName, colorValue);

      cssLines.push(`  ${varName}: ${colorValue};`);
    }
    cssLines.push('');
  }

  return { cssLines, tokenMap };
}

/**
 * Processes Semantic Color Roles tokens
 * Generates `--color-*` variables referencing primitive variables
 *
 * @param {Object} colorRolesGroup - The 'color roles' object from JSON
 * @param {Map<string, string>} primitiveTokenMap - Map of primitive tokens for resolution
 * @returns {{ cssLines: string[] }}
 */
function processColorRoles(colorRolesGroup, primitiveTokenMap) {
  const cssLines = [];

  cssLines.push('  /* ==========================================================================');
  cssLines.push('     2. SEMANTIC COLOR ROLES (UI-Facing Application Colors)');
  cssLines.push('     APPLY THESE DIRECTLY IN UI STYLES. All components must consume these tokens.');
  cssLines.push('     ========================================================================== */\n');

  for (const [roleName, roleData] of Object.entries(colorRolesGroup)) {
    const varName = `--color-${toKebabCase(roleName)}`;
    const ref = parseTokenReference(roleData.value);

    if (ref) {
      // Find fallback raw value if available
      const rawValue = primitiveTokenMap.get(ref.cssVar) || '';
      const fallbackComment = rawValue ? ` /* ${rawValue} */` : '';
      cssLines.push(`  ${varName}: var(${ref.cssVar});${fallbackComment}`);
    } else {
      cssLines.push(`  ${varName}: ${roleData.value};`);
    }
  }
  cssLines.push('');

  return { cssLines };
}

/**
 * Spacing semantic aliases mapping
 */
const SPACING_NAME_MAP = {
  'no spacing': 'none',
  'extra small spacing': 'xs',
  'small spacing': 'sm',
  'medium spacing': 'md',
  'base spacing': 'base',
  'large spacing': 'lg',
  'extra large spacing': 'xl',
  'very large spacing': '2xl',
};

/**
 * Processes Spacing tokens
 * Generates `--spacing-*` variables
 *
 * @param {Object} spacingGroup - The 'spacing collection' object from JSON
 * @returns {{ cssLines: string[] }}
 */
function processSpacing(spacingGroup) {
  const cssLines = [];

  cssLines.push('  /* ==========================================================================');
  cssLines.push('     3. SPACING SCALE');
  cssLines.push('     Use for margins, paddings, gaps, and structural layout dimensions.');
  cssLines.push('     ========================================================================== */\n');

  for (const [tokenName, tokenData] of Object.entries(spacingGroup)) {
    const rawVal = tokenData.value;
    const pxVal = formatDimension(rawVal);
    const shortName = SPACING_NAME_MAP[tokenName.toLowerCase()] || toKebabCase(tokenName);
    const varName = `--spacing-${shortName}`;
    const remVal = typeof rawVal === 'number' && rawVal > 0 ? ` /* ${(rawVal / CONFIG.baseFontSize).toFixed(3).replace(/\.?0+$/, '')}rem */` : '';

    cssLines.push(`  ${varName}: ${pxVal};${remVal}`);
  }
  cssLines.push('');

  return { cssLines };
}

/**
 * Processes Typography tokens
 * Generates `--typography-*` variables and composable CSS utility classes
 *
 * @param {Object} typographyGroup - The 'typography' object from JSON
 * @returns {{ cssVarLines: string[], utilityClassLines: string[] }}
 */
function processTypography(typographyGroup) {
  const cssVarLines = [];
  const utilityClassLines = [];

  cssVarLines.push('  /* ==========================================================================');
  cssVarLines.push('     4. TYPOGRAPHY TOKENS');
  cssVarLines.push('     Atomic typography scale tokens (font-size, weight, line-height, etc.).');
  cssVarLines.push('     ========================================================================== */\n');

  utilityClassLines.push('/* ==========================================================================');
  utilityClassLines.push('   TYPOGRAPHY UTILITY CLASSES');
  utilityClassLines.push('   Apply these utility classes directly to elements for typography styling.');
  utilityClassLines.push('   ========================================================================== */\n');

  for (const [styleName, styleProperties] of Object.entries(typographyGroup)) {
    const cleanStyleName = toKebabCase(styleName);
    const prefix = `--typography-${cleanStyleName}`;

    cssVarLines.push(`  /* Typography: ${styleName} */`);

    const fontSize = styleProperties.fontSize ? formatDimension(styleProperties.fontSize.value) : 'inherit';
    const lineHeight = styleProperties.lineHeight ? formatDimension(styleProperties.lineHeight.value) : 'normal';
    const fontWeight = styleProperties.fontWeight ? styleProperties.fontWeight.value : 'normal';
    const fontFamily = styleProperties.fontFamily ? `"${styleProperties.fontFamily.value}", sans-serif` : 'inherit';
    const letterSpacing = styleProperties.letterSpacing ? formatDimension(styleProperties.letterSpacing.value) : '0px';

    cssVarLines.push(`  ${prefix}-font-family: ${fontFamily};`);
    cssVarLines.push(`  ${prefix}-font-size: ${fontSize};`);
    cssVarLines.push(`  ${prefix}-font-weight: ${fontWeight};`);
    cssVarLines.push(`  ${prefix}-line-height: ${lineHeight};`);
    cssVarLines.push(`  ${prefix}-letter-spacing: ${letterSpacing};`);
    cssVarLines.push('');

    // Utility class
    utilityClassLines.push(`.type-${cleanStyleName} {`);
    utilityClassLines.push(`  font-family: var(${prefix}-font-family);`);
    utilityClassLines.push(`  font-size: var(${prefix}-font-size);`);
    utilityClassLines.push(`  font-weight: var(${prefix}-font-weight);`);
    utilityClassLines.push(`  line-height: var(${prefix}-line-height);`);
    utilityClassLines.push(`  letter-spacing: var(${prefix}-letter-spacing);`);
    utilityClassLines.push(`}\n`);
  }

  return { cssVarLines, utilityClassLines };
}

/**
 * Processes Effect / Shadow tokens
 * Generates `--effect-*` box-shadow variables
 *
 * @param {Object} effectsGroup - The 'effect' object from JSON
 * @returns {{ cssLines: string[] }}
 */
function processEffects(effectsGroup) {
  const cssLines = [];

  cssLines.push('  /* ==========================================================================');
  cssLines.push('     5. EFFECTS / SHADOWS');
  cssLines.push('     Elevation and box-shadow tokens for depth and card elevation.');
  cssLines.push('     ========================================================================== */\n');

  for (const [effectName, effectData] of Object.entries(effectsGroup)) {
    const cleanName = toKebabCase(effectName);
    const varName = `--effect-${cleanName}`;
    const v = effectData.value;

    if (v && typeof v === 'object') {
      const offsetX = formatDimension(v.offsetX || 0);
      const offsetY = formatDimension(v.offsetY || 0);
      const radius = formatDimension(v.radius || 0);
      const spread = formatDimension(v.spread || 0);
      const color = v.color || '#000000';
      const shadowCss = `${offsetX} ${offsetY} ${radius} ${spread} ${color}`;

      cssLines.push(`  ${varName}: ${shadowCss};`);
    }
  }
  cssLines.push('');

  return { cssLines };
}

/**
 * Main conversion runner
 * Reads token JSON, transforms tokens into CSS, and writes output files.
 *
 * @param {string} [inputPath] - Optional custom path to tokens JSON file
 * @param {string} [outputDir] - Optional custom output directory
 */
function convertTokens(inputPath = CONFIG.defaultInput, outputDir = CONFIG.defaultOutputDir) {
  const resolvedInput = path.resolve(process.cwd(), inputPath);
  const resolvedOutputDir = path.resolve(process.cwd(), outputDir);

  console.log(`\n======================================================`);
  console.log(`🎨 Design Tokens to CSS Variables Converter`);
  console.log(`======================================================`);
  console.log(`Reading tokens from: ${resolvedInput}`);

  if (!fs.existsSync(resolvedInput)) {
    console.error(`❌ Error: Input file not found at ${resolvedInput}`);
    process.exit(1);
  }

  const rawJson = fs.readFileSync(resolvedInput, 'utf-8');
  let tokenData;
  try {
    tokenData = JSON.parse(rawJson);
  } catch (err) {
    console.error(`❌ Error parsing JSON from ${resolvedInput}:`, err.message);
    process.exit(1);
  }

  // Ensure output directory exists
  if (!fs.existsSync(resolvedOutputDir)) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
  }

  // 1. Process Primitives
  const primitiveResult = tokenData['primitives colors']
    ? processPrimitiveColors(tokenData['primitives colors'])
    : { cssLines: [], tokenMap: new Map() };

  // 2. Process Color Roles
  const roleResult = tokenData['color roles']
    ? processColorRoles(tokenData['color roles'], primitiveResult.tokenMap)
    : { cssLines: [] };

  // 3. Process Spacing
  const spacingResult = tokenData['spacing collection']
    ? processSpacing(tokenData['spacing collection'])
    : { cssLines: [] };

  // 4. Process Typography
  const typographyResult = tokenData['typography']
    ? processTypography(tokenData['typography'])
    : { cssVarLines: [], utilityClassLines: [] };

  // 5. Process Effects
  const effectResult = tokenData['effect']
    ? processEffects(tokenData['effect'])
    : { cssLines: [] };

  // Assemble full master CSS file
  const bannerHeader = `/**
 * ==============================================================================
 * DESIGN SYSTEM CSS TOKENS
 * Generated automatically by convert-tokens.js
 * Source: ${path.basename(resolvedInput)}
 * Generated at: ${new Date().toISOString()}
 *
 * COLOR ARCHITECTURE NOTICE:
 * - DO NOT apply primitive colors (--primitive-color-*) directly to UI elements.
 * - ALWAYS use semantic color roles (--color-*) for UI styling.
 * ==============================================================================
 */\n`;

  const rootVariables = [
    ':root {',
    ...primitiveResult.cssLines,
    ...roleResult.cssLines,
    ...spacingResult.cssLines,
    ...typographyResult.cssVarLines,
    ...effectResult.cssLines,
    '}\n',
  ].join('\n');

  const fullCss = bannerHeader + rootVariables + '\n' + typographyResult.utilityClassLines.join('\n');

  // Modular CSS files
  const primitiveCss = bannerHeader + ':root {\n' + primitiveResult.cssLines.join('\n') + '}\n';
  const semanticCss = bannerHeader + ':root {\n' + roleResult.cssLines.join('\n') + '}\n';
  const spacingCss = bannerHeader + ':root {\n' + spacingResult.cssLines.join('\n') + '}\n';
  const typographyCss = bannerHeader + ':root {\n' + typographyResult.cssVarLines.join('\n') + '}\n\n' + typographyResult.utilityClassLines.join('\n');
  const effectCss = bannerHeader + ':root {\n' + effectResult.cssLines.join('\n') + '}\n';

  // Write files
  const masterFile = path.join(resolvedOutputDir, 'tokens.css');
  fs.writeFileSync(masterFile, fullCss, 'utf-8');
  console.log(`✅ Generated master tokens CSS: ${masterFile}`);

  fs.writeFileSync(path.join(resolvedOutputDir, 'tokens.primitives.css'), primitiveCss, 'utf-8');
  console.log(`✅ Generated primitives CSS: tokens.primitives.css`);

  fs.writeFileSync(path.join(resolvedOutputDir, 'tokens.semantic.css'), semanticCss, 'utf-8');
  console.log(`✅ Generated semantic roles CSS: tokens.semantic.css`);

  fs.writeFileSync(path.join(resolvedOutputDir, 'tokens.spacing.css'), spacingCss, 'utf-8');
  console.log(`✅ Generated spacing CSS: tokens.spacing.css`);

  fs.writeFileSync(path.join(resolvedOutputDir, 'tokens.typography.css'), typographyCss, 'utf-8');
  console.log(`✅ Generated typography CSS: tokens.typography.css`);

  fs.writeFileSync(path.join(resolvedOutputDir, 'tokens.effects.css'), effectCss, 'utf-8');
  console.log(`✅ Generated effects CSS: tokens.effects.css`);

  console.log(`\n🎉 Conversion complete! All tokens successfully written to '${outputDir}/'.\n`);
}

// Support CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  const inputArg = args[0] || CONFIG.defaultInput;
  const outputArg = args[1] || CONFIG.defaultOutputDir;

  convertTokens(inputArg, outputArg);
}

module.exports = {
  convertTokens,
  processPrimitiveColors,
  processColorRoles,
  processSpacing,
  processTypography,
  processEffects,
  toKebabCase,
  formatDimension,
  parseTokenReference,
};
