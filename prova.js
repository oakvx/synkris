import { handleMessage, resetState } from "./util.js";

const fakeClient = {
  sendText: async (chatId, text) => console.log("\n[BOT]", text),
};

const chatId = "TEST@c.us";

resetState(chatId);
await handleMessage(fakeClient, chatId, "cancella dati", {});

// caso target
await handleMessage(fakeClient, chatId, "voglio un appuntamento il 15 alle 13", {});

// scegli un trattamento dalla lista (metti un numero valido)
await handleMessage(fakeClient, chatId, "1", {});

// ora dovrebbe andare su giorno/orari: se il giorno è già stato capito, ti mostrerà gli slot del 15
// scegli l'orario richiesto (13:00) oppure uno disponibile
await handleMessage(fakeClient, chatId, "13:00", {});
