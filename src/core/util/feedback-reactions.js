/**
 * Recognize short feedback consisting entirely of pictographic reactions.
 * Unicode properties avoid maintaining a hard-coded list of characters.
 */
const REACTION_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\uFE0F|\u200D)+$/u;

export function isReactionOnly(value) {
  const text = String(value ?? '').replace(/\s+/g, '');
  return text.length > 0 && REACTION_ONLY.test(text);
}
