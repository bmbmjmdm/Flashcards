const elements = {
  card: document.querySelector("[data-card]"),
  question: document.querySelector("[data-question]"),
  answer: document.querySelector("[data-answer]"),
  status: document.querySelector("[data-status]"),
  nextReview: document.querySelector("[data-next-review]"),
  lastAction: document.querySelector("[data-last-action]"),
  cardHint: document.querySelector("[data-card-hint]"),
  emptyHint: document.querySelector("[data-empty-hint]"),
  totals: {
    total: document.querySelector("[data-total]"),
    remaining: document.querySelector("[data-remaining]"),
    retired: document.querySelector("[data-retired]"),
    due: document.querySelector("[data-due]")
  }
};

const buttons = Array.from(document.querySelectorAll("[data-rating]"));
const ratingLabels = {
  trivial: "Trivial",
  easy: "Easy",
  normal: "Normal",
  hard: "Hard"
};

let currentCard = null;
let busy = false;

buttons.forEach((button) => {
  button.addEventListener("click", () => {
    const rating = button.dataset.rating;
    if (!rating) {
      return;
    }
    handleRating(rating);
  });
});

elements.card.addEventListener("click", () => {
  if (!currentCard || busy) {
    return;
  }
  elements.card.classList.toggle("show-answer");
});

init();

async function init() {
  await loadNextCard();
}

async function loadNextCard() {
  setBusy(true, "Loading next card…");
  try {
    const payload = await apiGet("/api/cards/next");
    renderPayload(payload);
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

async function handleRating(rating) {
  if (!currentCard || busy) {
    return;
  }

  setBusy(true, `Scoring as ${ratingLabels[rating]}…`);
  try {
    const payload = await apiPost(`/api/cards/${currentCard.id}/rate`, { rating });
    renderPayload(payload);
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

function renderPayload(payload) {
  renderMeta(payload.meta);
  updateCard(payload.card);
  updateStatus(payload);
}

function updateCard(cardData) {
  currentCard = cardData;
  elements.card.classList.remove("show-answer");

  if (!cardData) {
    elements.question.textContent = "All caught up!";
    elements.answer.textContent = "You can close the app and return later – your progress is saved.";
    elements.cardHint.hidden = true;
    elements.emptyHint.hidden = false;
    buttons.forEach((button) => {
      button.disabled = true;
    });
    return;
  }

  elements.question.textContent = cardData.question;
  setTimeout(() => {
    elements.answer.textContent = cardData.answer;
  }, 500);
  elements.cardHint.hidden = false;
  elements.emptyHint.hidden = true;
  buttons.forEach((button) => {
    button.disabled = false;
  });
}

function updateStatus(payload) {
  if (payload.card) {
    elements.status.textContent = "Card ready — tap to flip";
  } else {
    elements.status.textContent = "Deck complete for now";
  }

  if (payload.rated) {
    const { rating, state } = payload.rated;
    const label = ratingLabels[rating] ?? rating;
    const nextText = state?.retired
      ? "Card retired"
      : describeDue(state?.dueAt);

    elements.lastAction.textContent = `${label} · ${nextText}`;
    elements.nextReview.textContent = nextText;
  } else if (payload.card?.state?.dueAt) {
    elements.nextReview.textContent = describeDue(payload.card.state.dueAt);
  } else {
    elements.nextReview.textContent = "—";
    elements.lastAction.textContent = "—";
  }
}

function renderMeta(meta) {
  if (!meta) {
    return;
  }
  elements.totals.total.textContent = meta.total ?? 0;
  elements.totals.remaining.textContent = meta.remaining ?? 0;
  elements.totals.retired.textContent = meta.retired ?? 0;
  elements.totals.due.textContent = meta.dueNow ?? 0;
}

function setBusy(state, message) {
  busy = state;
  buttons.forEach((button) => {
    button.disabled = state || !currentCard;
  });
  if (message) {
    elements.status.textContent = message;
  }
}

function showError(message) {
  elements.status.textContent = message ?? "Something went wrong";
}

async function apiGet(url) {
  const response = await fetch(url);
  return parseResponse(response);
}

async function apiPost(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

async function parseResponse(response) {
  if (!response.ok) {
    let message = "Request failed";
    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch (error) {
      // Ignore JSON parse errors and keep fallback message.
    }
    throw new Error(message);
  }
  return response.json();
}

function describeDue(isoString) {
  if (!isoString) {
    return "Ready now";
  }
  const due = new Date(isoString);
  const delta = due.getTime() - Date.now();
  if (!Number.isFinite(delta)) {
    return "Scheduled";
  }
  if (delta <= 0) {
    return "Ready now";
  }

  const minutes = Math.round(delta / 60000);
  if (minutes < 60) {
    return `in ${minutes} min`;
  }
  const hours = minutes / 60;
  if (hours < 24) {
    return `in ${hours.toFixed(1)} h`;
  }
  const days = hours / 24;
  return `in ${days.toFixed(1)} d`;
}
