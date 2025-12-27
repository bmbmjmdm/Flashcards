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
    const retired = Math.max(total - remaining, 0);
    const dueNow = remaining > 0 ? 1 : 0;

    return { total, remaining, retired, dueNow };
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
    const insertIndex = getReinsertIndex(normalizedRating, state.queue.length);
    state.queue.splice(insertIndex, 0, numericCardId);

    currentState.retired = false;
    currentState.intervalDays = 0;
    currentState.dueAt = null;

    currentState.lastReviewed = new Date(now).toISOString();
    currentState.lastRating = normalizedRating;
    currentState.reviewCount = (currentState.reviewCount ?? 0) + 1;
    state.cards[key] = currentState;
    state.updatedAt = currentState.lastReviewed;
    await saveState(state);

    return buildResponse(selectNext(), {
      rated: {
        id: numericCardId,
        rating: normalizedRating,
        state: toClientState(state, numericCardId)
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
      cards: parsed.cards ?? {},
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
  return {
    intervalDays: 0,
    dueAt: null,
    retired: false,
    reviewCount: 0,
    lastReviewed: null,
    lastRating: null
  };
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

function getReinsertIndex(rating, queueLength) {
  const fallback = CARD_REINSERT_OFFSETS.normal ?? queueLength;
  const rawOffset = CARD_REINSERT_OFFSETS[rating];
  if (rawOffset === undefined) {
    return Math.min(Math.max(fallback, 0), queueLength);
  }
  if (!Number.isFinite(rawOffset)) {
    return queueLength;
  }
  const offset = Math.max(Math.floor(rawOffset), 0);
  return Math.min(offset, queueLength);
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
  return { ...snapshot };
}
