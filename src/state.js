import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DEFAULT_STATE = Object.freeze({ version: 2, updatedAt: null, cards: {}, queue: [] });
const CARD_REINSERT_OFFSETS = Object.freeze({
  trivial: Number.POSITIVE_INFINITY,
  easy: 30,
  normal: 15,
  hard: 5
});
const EASY_REVIEW_BONUS = 10;
const NORMAL_REVIEW_ADJUSTMENT = 1;
const LEGACY_REVIEW_LIMIT = 100;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DECK_FILE = path.join(DATA_DIR, "socialstudies.json");
const STATE_FILE = path.join(DATA_DIR, "card-state.json");

const allowedRatings = new Set(["trivial", "easy", "normal", "hard"]);
const ratingAliases = Object.freeze({ medium: "normal" });

export async function createScheduler() {
  const cards = await loadCards();
  const cardIndex = buildCardIndex(cards);
  const state = await loadState();
  const queueUpdated = syncQueueWithDeck(state, cards);
  if (queueUpdated) {
    await saveState(state);
  }

  function computeMeta() {
    const total = cards.length;
    const remaining = state.queue.length;
    const reviewed = countTotalReviews(state.cards);
    return { total, remaining, reviewed };
  }

  function selectNext() {
    if (!state.queue.length) {
      return null;
    }

    const cardId = state.queue[0];
    const card = cardIndex.get(cardId);
    if (!card) {
      return null;
    }
    const snapshot = getStoredState(state, card.id);
    return { card, snapshot };
  }

  function buildCardPayload(selection) {
    if (!selection) {
      return null;
    }

    return {
      id: selection.card.id,
      question: selection.card.question,
      answer: selection.card.answer,
      state: toClientState(state, selection.card.id)
    };
  }

  function buildResponse(selection, extra = {}) {
    return {
      card: buildCardPayload(selection),
      meta: computeMeta(),
      generatedAt: new Date().toISOString(),
      ...extra
    };
  }

  async function rateCard(cardId, rating) {
    const normalizedRating = normalizeRatingOption(rating);
    if (!allowedRatings.has(normalizedRating)) {
      const error = new Error("Unsupported rating option");
      error.statusCode = 400;
      throw error;
    }

    const numericCardId = Number(cardId);
    if (!Number.isFinite(numericCardId)) {
      const error = new Error("Invalid card identifier");
      error.statusCode = 400;
      throw error;
    }

    const card = cardIndex.get(numericCardId);
    if (!card) {
      const error = new Error("Card not found");
      error.statusCode = 404;
      throw error;
    }

    const key = String(numericCardId);
    const currentState = structuredClone(state.cards[key] ?? getDefaultCardState());
    const now = Date.now();

    removeCardFromQueue(state.queue, numericCardId);
    const insertIndex = getReinsertIndex(normalizedRating, state.queue.length, currentState);
    state.queue.splice(insertIndex, 0, numericCardId);

    if (!Array.isArray(currentState.reviews)) {
      currentState.reviews = [];
    }
    currentState.reviews.push(normalizedRating);
    state.cards[key] = currentState;
    state.updatedAt = new Date(now).toISOString();
    await saveState(state);

    return buildResponse(selectNext(), {
      rated: {
        id: numericCardId,
        rating: normalizedRating,
        state: toClientState(state, numericCardId),
        queueIndex: insertIndex,
        queuePosition: insertIndex + 1
      }
    });
  }

  function getNextCard() {
    return buildResponse(selectNext());
  }

  return { getNextCard, rateCard };
}

async function loadCards() {
  try {
    const raw = await fs.readFile(DECK_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed.map((item, index) => ({
      id: index + 1,
      question: (item.question ?? "").trim(),
      answer: (item.answer ?? "").trim()
    }));
  } catch (error) {
    error.message = `Unable to load flashcards from ${DECK_FILE}: ${error.message}`;
    throw error;
  }
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version ?? DEFAULT_STATE.version,
      updatedAt: parsed.updatedAt ?? DEFAULT_STATE.updatedAt,
      cards: normalizeCardStateMap(parsed.cards),
      queue: Array.isArray(parsed.queue) ? parsed.queue.map((value) => Number(value)) : []
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      await saveState(structuredClone(DEFAULT_STATE));
      return structuredClone(DEFAULT_STATE);
    }
    error.message = `Unable to load scheduler state: ${error.message}`;
    throw error;
  }
}

async function saveState(content) {
  await fs.writeFile(STATE_FILE, JSON.stringify(content, null, 2), "utf-8");
}

function getStoredState(state, cardId) {
  return state.cards[String(cardId)] ?? getDefaultCardState();
}

function getDefaultCardState() {
  return { reviews: [] };
}

function buildCardIndex(cards) {
  return new Map(cards.map((card) => [card.id, card]));
}

function normalizeRatingOption(input) {
  if (typeof input !== "string") {
    return input;
  }
  const safeValue = input.toLowerCase();
  return ratingAliases[safeValue] ?? safeValue;
}

function getReinsertIndex(rating, queueLength, cardState = null) {
  const fallback = CARD_REINSERT_OFFSETS.normal ?? queueLength;
  const rawOffset = CARD_REINSERT_OFFSETS[rating];
  if (rawOffset === undefined) {
    return Math.min(Math.max(fallback, 0), queueLength);
  }
  if (!Number.isFinite(rawOffset)) {
    return queueLength;
  }
  let offset = Math.max(Math.floor(rawOffset), 0);
  const stats = summarizeReviewHistory(cardState);

  if (rating === "easy") {
    offset += stats.easy * EASY_REVIEW_BONUS;
  } else if (rating === "hard") {
  } else if (rating === "normal") {
    if (stats.hard > (stats.normal + stats.easy)) {
      offset -= (stats.hard - (stats.normal + stats.easy)) * NORMAL_REVIEW_ADJUSTMENT;
    }
    if (stats.easy > (stats.hard + stats.normal)) {
      offset += (stats.easy - (stats.hard + stats.normal)) * NORMAL_REVIEW_ADJUSTMENT;
    }

    offset = Math.max(offset, 5);
    offset = Math.min(offset, 30);
  }

  offset = Math.max(offset, 1);
  return Math.min(offset, queueLength);
}

function summarizeReviewHistory(cardState) {
  const reviews = Array.isArray(cardState?.reviews) ? cardState.reviews : [];
  const stats = { easy: 0, normal: 0, hard: 0 };
  for (const review of reviews) {
    if (review === "easy") {
      stats.easy += 1;
    } else if (review === "normal") {
      stats.normal += 1;
    } else if (review === "hard") {
      stats.hard += 1;
    }
  }
  return stats;
}

function removeCardFromQueue(queue, cardId) {
  if (!Array.isArray(queue)) {
    return;
  }
  const index = queue.indexOf(cardId);
  if (index === -1) {
    return;
  }
  queue.splice(index, 1);
}

function syncQueueWithDeck(state, cards) {
  let mutated = false;
  if (!Array.isArray(state.queue)) {
    state.queue = [];
    mutated = true;
  }

  const validIds = new Set(cards.map((card) => card.id));
  const seen = new Set();
  const normalizedQueue = [];

  for (const entry of state.queue) {
    const numericId = Number(entry);
    const id = Number.isFinite(numericId) ? Math.trunc(numericId) : Number.NaN;
    if (!Number.isFinite(id) || !validIds.has(id) || seen.has(id)) {
      mutated = true;
      continue;
    }
    seen.add(id);
    normalizedQueue.push(id);
  }

  if (normalizedQueue.length !== state.queue.length) {
    mutated = true;
  }

  state.queue = normalizedQueue;

  for (const card of cards) {
    if (seen.has(card.id)) {
      continue;
    }
    state.queue.push(card.id);
    seen.add(card.id);
    mutated = true;
  }

  return mutated;
}

function toClientState(state, cardId) {
  const snapshot = state.cards[String(cardId)];
  if (!snapshot) {
    return getDefaultCardState();
  }
  const reviews = Array.isArray(snapshot.reviews) ? [...snapshot.reviews] : [];
  return { reviews };
}

function normalizeCardStateMap(rawCards) {
  if (!rawCards || typeof rawCards !== "object") {
    return {};
  }
  const normalized = {};
  for (const [key, snapshot] of Object.entries(rawCards)) {
    normalized[key] = normalizeReviewSnapshot(snapshot);
  }
  return normalized;
}

function normalizeReviewSnapshot(snapshot) {
  if (snapshot && typeof snapshot === "object" && Array.isArray(snapshot.reviews)) {
    return { reviews: sanitizeReviews(snapshot.reviews) };
  }
  if (snapshot && typeof snapshot === "object") {
    return upgradeLegacySnapshot(snapshot);
  }
  return getDefaultCardState();
}

function countTotalReviews(cardStates) {
  if (!cardStates || typeof cardStates !== "object") {
    return 0;
  }
  let sum = 0;
  for (const snapshot of Object.values(cardStates)) {
    if (Array.isArray(snapshot?.reviews)) {
      sum += snapshot.reviews.length;
    }
  }
  return sum;
}

function sanitizeReviews(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const sanitized = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = normalizeRatingOption(value);
    if (typeof normalized === "string" && allowedRatings.has(normalized)) {
      sanitized.push(normalized);
    }
  }
  return sanitized;
}

function upgradeLegacySnapshot(snapshot) {
  const rating = typeof snapshot.lastRating === "string" ? normalizeRatingOption(snapshot.lastRating) : null;
  if (!rating || !allowedRatings.has(rating)) {
    return getDefaultCardState();
  }
  const count = Number(snapshot.reviewCount);
  const repeat = Number.isFinite(count) && count > 0 ? Math.min(Math.trunc(count), LEGACY_REVIEW_LIMIT) : 1;
  const reviews = Array(repeat).fill(rating);
  return { reviews };
}
