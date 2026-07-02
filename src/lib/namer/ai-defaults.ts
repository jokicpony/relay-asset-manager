/**
 * Default Gemini prompts for namer AI analysis.
 *
 * Single source of truth shared by /api/namer/analyze (runtime fallback when
 * no custom prompt is configured) and /api/namer/settings (seed values shown
 * in the Settings UI). Keep these identical so what users see in Settings is
 * exactly what the analyzer runs with.
 */

export const DEFAULT_SYSTEM_PROMPT = `You are a Senior Creative Asset Manager optimizing images for semantic search in a Digital Asset Management system. Your keywords should help users find assets by searching for the MOOD, ACTIVITY, SETTING, PRODUCTS, or EMOTIONAL VIBE. Balance factual descriptors (objects, location) with experiential terms (feelings, activities, atmospheres).`;

export const DEFAULT_USER_PROMPT = `Analyze this image and return a JSON object with the following fields:

context_environment: The primary setting as a brief phrase. (e.g., "freshwater river", "minimalist product studio", "alpine forest trail")

seasonality: Season or weather conditions visible. (e.g., "summer", "winter storm", "golden autumn")

lighting_mood: The light quality and emotional effect. (e.g., "warm golden hour", "dramatic storm light", "soft overcast")

human_experience: Array of 2-3 activity or lifestyle descriptors. (e.g., ["fly fishing adventure", "peaceful nature retreat"])

primary_objects: Array of 3-4 most important visible subjects. (e.g., ["insulated flask", "fly rod", "mountain stream"])

color_palette: Array of 3 dominant HEX codes representing the image mood.

label_csv: A single comma-separated string of 12-15 discovery keywords optimized for semantic search.

Constraints: Output ONLY valid JSON. Keep individual tags to 1-3 words. Be specific and descriptive.`;
