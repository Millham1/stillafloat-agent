// group-journey-strings.ts — every word the journey emails and the traveler's cruise page say, English and
// Spanish side by side (Mark 2026-10-08: "Spanish is first-class"). There is no machine translation at runtime:
// the Spanish object is typed against the English one, so a sentence added to one without the other does not compile.
//
// VOICE (Mark's rulings): Still Afloat Cruising, "Cruise smarter, laugh more" — plain, practical, at most one dry
// line per email, no hype, no emojis, no exclamation marks, never "cheaper" (say "less expensive"), never "actually".
// Mark is the contact (third person), never "I". Editorial liability: explain, never promise an entitlement;
// passport, visa and entry lines point to the cruise line and the traveler's government's travel site.
// Spanish uses "usted" (the group pages do, unless the notes say family).

import { BUSINESS } from "./group-secure";

export type Lang = "en" | "es";

export type MilestoneKind =
  | "confirmation" | "t-120" | "t-90" | "t-45" | "t-20" | "t-10" | "t-5" | "t-2"
  | "payment-due" | "data-needed" | "change-notice";

export interface MissingItem { key: "paperwork" | "travel-in" | "travel-out" | "emergency"; n?: number }

/** "MSC Seaside" already carries its line; "Celebration" does not. */
function shipWithLine(ship: string, line: string): string {
  if (!ship || !line) return ship || line;
  const lead = line.split(/\s+/)[0]!.toLowerCase();
  return ship.toLowerCase().startsWith(lead) ? ship : `${line} ${ship}`;
}

const contactBits = `${BUSINESS.agentName} · ${BUSINESS.phone} · ${BUSINESS.email}`;

const en = {
  htmlLang: "en",
  locale: "en-US",
  hello: (n: string) => (n ? `Hello ${n},` : "Hello,"),
  contact: `Questions? ${contactBits}`,
  signoff: BUSINESS.tradeName,
  button: "Open your cruise page",
  pasteLink: "Or paste this link into your browser:",
  inEnglishNote: "(in English)",
  yourCruise: "your cruise",

  subject: {
    confirmation: (p: { ship: string; date: string }) => `You are booked${p.ship ? `: ${p.ship}` : ""}${p.date ? `, sailing ${p.date}` : ""}`,
    days: (p: { days: number; topic: string }) => `${p.days} ${p.days === 1 ? "day" : "days"} to go: ${p.topic}`,
    paymentDue: (p: { date: string; amount: string }) => `Payment due ${p.date}${p.amount ? `: ${p.amount}` : ""}`,
    change: (p: { group: string }) => `A change to your cruise${p.group ? `: ${p.group}` : ""}`,
    dataNeeded: (p: { ship: string }) => `A few details we still need${p.ship ? ` for your ${p.ship} cruise` : ""}`,
  },
  topic: {
    "t-120": "payments, paperwork and what to do first",
    "t-90": "final payment, line deadlines and getting to the ship",
    "t-45": "excursions, dining and what is still open",
    "t-20": "check-in, documents and packing",
    "t-10": "your ship and how boarding day works",
    "t-5": "the forecast for your cruise",
    "t-2": "check-in, boarding and what to bring",
  } as Record<string, string>,
  intro: {
    confirmation: "Your cabin is booked. Here is what is on file for it, and what comes next.",
    "t-120": "Nothing below is urgent, and all of it is easier to do now than the week before you leave.",
    "t-90": "This is when the dates that matter start to show up: payments, deadlines from the cruise line, and how you are getting to the ship.",
    "t-45": "This is the time to settle excursions and dining, and to send us anything still missing.",
    "t-20": "Check-in, the documents to bring, and the bag.",
    "t-10": "Here is your ship, and how boarding day works.",
    "t-5": "The forecast for your cruise, and a last look at the bag.",
    "t-2": "Check-in, boarding, and the short list of what to have in your hand.",
    "payment-due": "A payment on your cruise is coming due.",
    "data-needed": "A few details are still missing from your file. Each takes a minute on your cruise page.",
    "change-notice": "There is a change to your cruise. The details are below.",
  } as Record<string, string>,
  closing: {
    "t-2": "See you aboard.",
  } as Record<string, string>,

  // sections ------------------------------------------------------------------------------------
  s: {
    sailing: "Your sailing",
    daysToGo: (n: number) => (n > 1 ? `${n} days to go.` : n === 1 ? "1 day to go." : n === 0 ? "You sail today." : ""),
    shipLine: (p: { ship: string; line: string; date: string; port: string }) =>
      [shipWithLine(p.ship, p.line), p.date ? `sailing ${p.date}` : "", p.port ? `from ${p.port}` : ""].filter(Boolean).join(", ") + ".",
    nightsLine: (p: { nights: number | null; back: string }) =>
      p.nights && p.back ? `${p.nights} nights, back on ${p.back}.` : p.nights ? `${p.nights} nights.` : p.back ? `Back on ${p.back}.` : "",
    cabinLine: (p: { category: string; num: string; deck: string }) =>
      `Your cabin: ${[p.category, p.num ? `cabin ${p.num}` : "", p.deck ? `deck ${p.deck}` : ""].filter(Boolean).join(", ")}.`,
    bookingNumber: (n: string) => `Booking number: ${n}.`,
    sharing: (names: string) => `Sharing the cabin with ${names}.`,
    cabin: "Your cabin",
    cabinRef: (num: string) => `cabin ${num}`,

    payments: "Payments",
    payForCabin: (num: string) => (num ? `These amounts are for cabin ${num}.` : "These amounts are for your cabin."),
    payKind: { deposit: "Deposit", final: "Final payment", other: "Payment" } as Record<string, string>,
    payPaid: (p: { kind: string; amount: string; date: string }) => `${p.kind}${p.amount ? `: ${p.amount}` : ""}, paid${p.date ? ` on ${p.date}` : ""}.`,
    payDue: (p: { kind: string; amount: string; date: string }) => `${p.kind}${p.amount ? `: ${p.amount}` : ""}, due ${p.date}.`,
    payOverdue: (p: { kind: string; amount: string; date: string }) => `${p.kind}${p.amount ? `: ${p.amount}` : ""}, was due ${p.date}. Please reply or call so we can sort it out.`,
    payNoDate: (p: { kind: string; amount: string }) => `${p.kind}${p.amount ? `: ${p.amount}` : ""}, date to be confirmed.`,
    payAllPaid: "Every payment on file is paid. Thank you.",
    payGroupFinal: (date: string) => `The final payment is due ${date}.`,
    payGroupDeposit: (date: string) => `The deposit deadline is ${date}.`,
    howToPay: BUSINESS.paymentMethods as string,

    paperwork: "Paperwork",
    paperworkCount: (p: { signed: number; total: number }) => `You have signed ${p.signed} of ${p.total} documents.`,
    paperworkToSign: "Still to sign:",
    paperworkLink: "Sign them on your private paperwork page",
    paperworkEnglishOnly: "",
    paperworkDone: "Your paperwork is complete. Thank you.",

    passport: "Passports",
    passportGeneral: "Every traveler needs a valid passport. Many countries ask that it stay valid for six months past the end of the trip, and some itineraries add entry rules of their own. Check with the cruise line and your government's travel website for the rules that apply to your citizenship and your ports.",
    passportBefore: (date: string) => `The passport on your file expires ${date}, before your cruise ends. Please check with the cruise line and renew it if you need to.`,
    passportSoon: (date: string) => `The passport on your file expires ${date}, less than six months after you return. Some countries ask for more than that, so it is worth checking.`,
    passportFine: (date: string) => `The passport on your file expires ${date}.`,

    insurance: "Travel insurance",
    insuranceOffer: `Travel insurance is optional. Mark offers Allianz plans. Reply to this email or call ${BUSINESS.phone} if you would like a quote or have questions.`,
    insuranceHave: "Travel insurance is on file for your cabin as accepted.",
    insuranceVideo: "A short video on how it works:",

    checklist: "Your checklist",
    checklistBy: (date: string) => `by ${date}`,
    checklistEmpty: "Nothing on your list right now.",

    travel: "Getting to the ship",
    travelOnFile: "On file for you:",
    travelNeeded: "Still needed:",
    travelFlightIn: "Flight to the port city",
    travelFlightOut: "Flight home",
    travelHotel: "Hotel before the cruise",
    travelTransfer: "Transfer",
    travelOptional: "If you have a hotel before the cruise or a transfer to the port, add those too, with the confirmation numbers.",
    travelAdd: "Add it on your cruise page",
    travelFlightInNeed: "Your flight into the port city (flight number, date and arrival time), or a note that you are driving or arranging it yourself",
    travelFlightOutNeed: "Your flight home, or a note that you are driving or arranging it yourself",
    travelRow: (p: { kind: string; what: string }) => `${p.kind}: ${p.what}`,

    missing: "What we still need",
    missingPaperwork: (n: number) => `Paperwork: ${n} ${n === 1 ? "document" : "documents"} still to sign`,
    missingTravelIn: "How you are getting to the port (flight, or a note that you are driving)",
    missingTravelOut: "How you are getting home (flight, or a note that you are driving)",
    missingEmergency: "An emergency contact (name and phone number)",
    missingLink: "Add it on your cruise page",

    deadlines: "Dates from the cruise line",
    deadlinesNote: "These come from your cruise line's booking terms, in the line's own words:",
    namesDue: (date: string) => `The cruise line needs passenger names by ${date}. Your paperwork is what lets us send them.`,

    excursions: "Excursions",
    excursionsLead: "Excursions worth a look for your ports:",
    dining: "Dining and changes",
    diningOnFile: (d: string) => `Dining on file for your cabin: ${d}.`,
    diningLead: "Dates from the cruise line's terms:",

    checkin: "Check-in",
    checkinOpens: (date: string) => `Web check-in opens ${date}.`,
    checkinCloses: (date: string) => `Check-in closes ${date}.`,
    checkinLine: "From the cruise line's terms:",
    checkinGeneral: "Complete the cruise line's online check-in before you travel. The line sets the dates, and they appear on your booking.",

    documents: "Documents to bring",
    docPassport: "Your passport, one for every traveler",
    docBooking: (n: string) => `Your booking number: ${n}`,
    docBoarding: "The boarding documents the cruise line issues when check-in is complete, printed or on your phone",
    docInsurance: "Your travel insurance policy details, if you bought a plan",
    docTravelRow: (p: { kind: string; what: string }) => `${p.kind}: ${p.what}`,
    docVisa: "If the line or a port requires a visa or another entry document, bring it. Check with the cruise line and your government's travel website, since the rules depend on your citizenship and your ports.",

    packing: "Packing",
    packingLead: "The cruise line publishes what it allows on board. Check its list before you pack.",
    packingItems: "From your list:",
    packingSite: "What to wear and cabin essentials, on our site:",
    packingWear: "What to wear",
    packingCabin: "Cabin essentials",
    packingBag: "Carry on: passports, medicine, boarding documents, a change of clothes and anything you cannot replace.",

    videos: "Videos from our channel",
    videosLead: "From the Still Afloat Cruising YouTube channel:",

    ship: "Your ship",
    shipClass: (p: { ship: string; cls: string }) => `${p.ship} is ${/^[aeiou]/i.test(p.cls) ? "an" : "a"} ${p.cls} class ship.`,
    shipScore: (p: { ship: string; score: string }) => `Our Conga Line score for ${p.ship}: ${p.score} out of 5.`,
    shipTracker: (ship: string) => `Follow ${ship || "the ship"} on our ship tracker`,
    shipBed: (b: string) => `Bed setup on file: ${b}.`,

    embark1: "Boarding day, part one",
    embarkPort: (p: { port: string; date: string }) => `You board at ${p.port}${p.date ? ` on ${p.date}` : ""}.`,
    embarkTerminal: "The terminal and your boarding time appear on the documents the cruise line issues at check-in.",
    embarkSails: (time: string) => `The ship is scheduled to leave at ${time}.`,
    embarkTold: (time: string) => `You told us you plan to be at the port around ${time}.`,
    embarkTransfer: (p: { what: string }) => `Your transfer to the port: ${p.what}`,
    embarkTags: "Put the luggage tags the cruise line provides on every checked bag before you leave home or the hotel.",
    embarkCarry: "Keep passports, medicine, boarding documents and valuables in your carry-on, not in the bags you hand over.",
    embarkMuster: "Every passenger takes part in the safety drill (the muster) before the ship leaves. Listen for the announcement and follow the cruise line's instructions.",
    embarkTermsLine: "From the cruise line's terms:",
    embark2: "Boarding day, part two",
    embark2Window: "Many cruise lines assign a boarding window. If yours did, arriving at that time is easier than arriving early.",
    embark2Arrive: (time: string) => `You told us you plan to arrive around ${time}. If that changes, update it on your cruise page.`,

    weather: "Forecast for your cruise",
    weatherHead: ["Day", "Place", "High / Low", "Sky"],
    weatherNote: (date: string) => `Forecast as of ${date}. It will change, so look again the day before you leave.`,
    weatherSample: "Preview only: this table uses today's real forecast, moved onto the sailing dates because the sailing is more than ten days away.",
    weatherCredit: "Weather data by Open-Meteo.com.",
    weatherTemp: (p: { high: number; low: number }) => `${p.high}° / ${p.low}°F`,
    storm: "Storm watch",
    stormLine: (p: { kind: string; ship: string }) => `Our Storm Watch lists ${p.ship} among the ships to watch for ${p.kind}. A listed ship is one to watch, not one that has changed course.`,
    stormLink: "See Storm Watch",
    packTweaks: "Last packing notes",
    tweakRain: "Showers show up in the forecast: a light rain jacket or a small umbrella.",
    tweakWarm: "It will be warm: sun protection, a hat and light clothes.",
    tweakCool: "Evenings may run cool: one light layer.",

    emergency: "Emergency contact",
    emergencyOnFile: (p: { name: string; phone: string }) => `We have on file: ${[p.name, p.phone].filter(Boolean).join(", ")}.`,
    emergencyNone: "We do not have an emergency contact on file for you.",
    emergencyChange: "Check it, or change it, on your cruise page",

    booked: "Your booking",
    signed: "What you have signed",
    signedRow: (p: { title: string; date: string }) => `${p.title}${p.date ? `, ${p.date}` : ""}`,
    signedNone: "No documents are signed yet. They are waiting on your private paperwork page.",
    next: "What comes next",
    nextRow: (p: { date: string; what: string }) => `${p.date}: ${p.what}`,
    nextTopics: {
      "t-120": "payments and paperwork", "t-90": "final payment and travel plans", "t-45": "excursions and dining",
      "t-20": "check-in, documents and packing", "t-10": "your ship and boarding day", "t-5": "the weather forecast", "t-2": "check-in and last details",
    } as Record<string, string>,

    payment: "The payment",
    paymentOne: (p: { amount: string; date: string; kind: string; cabin: string }) =>
      `${p.kind}: ${p.amount ? `${p.amount} ` : ""}is due on ${p.date}${p.cabin ? ` for ${p.cabin}` : ""}.`,
    howToPayTitle: "How to pay",
    paymentNote: "Note on file:",

    change: "What changed",
    changeFrom: "Was",
    changeTo: "Now",
    changeLabel: "Item",
    changeNoteEs: "",
  },

  // the cruise page ---------------------------------------------------------------------------
  hub: {
    title: "Your cruise",
    helloLead: (n: string) => (n ? `Hello ${n}.` : "Hello."),
    noticesTitle: "Changes to your cruise",
    noticesEmpty: "",
    detailsTitle: "Tell us how you are getting there",
    detailsLead: "Anything you add here goes straight to your file. Leave out what does not apply.",
    save: "Save",
    saved: "Saved. Thank you.",
    saveFailed: "That did not save. Please check the lines marked below and try again.",
    langSwitch: "En español",
    tick: "Done",
    openPaperwork: "Open your paperwork",
    contactTitle: "Questions",
    sectionEmpty: "",
    badLink: "This link is not valid. Please check that you opened the whole link from your email, or ask Mark for a new one.",
    footer: BUSINESS.legalName,
    fields: {
      getting_there: "How are you getting to the port?",
      getting_there_flying: "Flying",
      getting_there_driving: "Driving",
      getting_there_other: "Another way, or we will arrange it ourselves",
      flight_in_flight: "Flight to the port city (airline and number)",
      flight_in_date: "Arrival date",
      flight_in_time: "Arrival time",
      flight_out_flight: "Flight home (airline and number)",
      flight_out_date: "Departure date",
      flight_out_time: "Departure time",
      hotel_name: "Hotel before the cruise",
      hotel_confirmation: "Hotel confirmation number",
      transfer_note: "Transfer to the port (company and pickup time)",
      transfer_confirmation: "Transfer confirmation number",
      port_arrival_time: "When you plan to be at the port",
      emergency_name: "Emergency contact name",
      emergency_phone: "Emergency contact phone",
    } as Record<string, string>,
  },

  // dashboard-visible problems the API returns to a traveler
  err: {
    notFound: "This link is not valid. Please check that you opened the whole link from your email, or ask Mark for a new one.",
    tooMany: "Too many attempts. Please try again later, or call Mark.",
    badField: "Please check this answer.",
    badDate: "Please enter a real date.",
    badTime: "Please enter a time, such as 14:30.",
    badPhone: "Please check the phone number.",
    card: "Card numbers are never collected here. Please remove it.",
    tooLong: "That is too long.",
    needName: "Please give a name for the emergency contact.",
    needPhone: "Please give a phone number for the emergency contact.",
  },
};

export type Strings = typeof en;

const es: Strings = {
  htmlLang: "es",
  locale: "es-419",
  hello: (n) => (n ? `Hola ${n},` : "Hola,"),
  contact: `¿Preguntas? ${contactBits}`,
  signoff: BUSINESS.tradeName,
  button: "Abrir la página de su crucero",
  pasteLink: "O copie este enlace en su navegador:",
  inEnglishNote: "(en inglés)",
  yourCruise: "su crucero",

  subject: {
    confirmation: (p) => `Su reserva está confirmada${p.ship ? `: ${p.ship}` : ""}${p.date ? `, salida el ${p.date}` : ""}`,
    days: (p) => `${p.days === 1 ? "Falta 1 día" : `Faltan ${p.days} días`}: ${p.topic}`,
    paymentDue: (p) => `Pago con vencimiento el ${p.date}${p.amount ? `: ${p.amount}` : ""}`,
    change: (p) => `Un cambio en su crucero${p.group ? `: ${p.group}` : ""}`,
    dataNeeded: (p) => `Algunos datos que todavía necesitamos${p.ship ? ` para su crucero en ${p.ship}` : ""}`,
  },
  topic: {
    "t-120": "pagos, documentos y qué hacer primero",
    "t-90": "pago final, fechas de la naviera y cómo llegar al barco",
    "t-45": "excursiones, comidas y lo que sigue pendiente",
    "t-20": "registro, documentos y equipaje",
    "t-10": "su barco y cómo funciona el día de embarque",
    "t-5": "el pronóstico del tiempo para su crucero",
    "t-2": "registro, embarque y qué llevar",
  },
  intro: {
    confirmation: "Su cabina está reservada. Esto es lo que tenemos en el archivo y lo que sigue.",
    "t-120": "Nada de lo que sigue es urgente, y todo es más fácil de hacer ahora que la semana antes de viajar.",
    "t-90": "Ahora empiezan a aparecer las fechas que importan: pagos, plazos de la naviera y cómo va a llegar al barco.",
    "t-45": "Este es el momento de decidir las excursiones y las comidas, y de enviarnos lo que todavía falta.",
    "t-20": "El registro, los documentos que debe llevar y la maleta.",
    "t-10": "Aquí está su barco, y cómo funciona el día de embarque.",
    "t-5": "El pronóstico del tiempo para su crucero, y una última mirada a la maleta.",
    "t-2": "Registro, embarque, y la lista corta de lo que debe tener a la mano.",
    "payment-due": "Se acerca la fecha de un pago de su crucero.",
    "data-needed": "Todavía faltan algunos datos en su archivo. Cada uno toma un minuto en la página de su crucero.",
    "change-notice": "Hay un cambio en su crucero. Los detalles están abajo.",
  },
  closing: {
    "t-2": "Nos vemos a bordo.",
  },

  s: {
    sailing: "Su viaje",
    daysToGo: (n) => (n > 1 ? `Faltan ${n} días.` : n === 1 ? "Falta 1 día." : n === 0 ? "Hoy zarpa." : ""),
    shipLine: (p) =>
      [shipWithLine(p.ship, p.line), p.date ? `salida el ${p.date}` : "", p.port ? `desde ${p.port}` : ""].filter(Boolean).join(", ") + ".",
    nightsLine: (p) =>
      p.nights && p.back ? `${p.nights} noches, regreso el ${p.back}.` : p.nights ? `${p.nights} noches.` : p.back ? `Regreso el ${p.back}.` : "",
    cabinLine: (p) =>
      `Su cabina: ${[p.category, p.num ? `cabina ${p.num}` : "", p.deck ? `cubierta ${p.deck}` : ""].filter(Boolean).join(", ")}.`,
    bookingNumber: (n) => `Número de reserva: ${n}.`,
    sharing: (names) => `Comparte la cabina con ${names}.`,
    cabin: "Su cabina",
    cabinRef: (num) => `la cabina ${num}`,

    payments: "Pagos",
    payForCabin: (num) => (num ? `Estos montos son para la cabina ${num}.` : "Estos montos son para su cabina."),
    payKind: { deposit: "Depósito", final: "Pago final", other: "Pago" },
    payPaid: (p) => `${p.kind}${p.amount ? `: ${p.amount}` : ""}, pagado${p.date ? ` el ${p.date}` : ""}.`,
    payDue: (p) => `${p.kind}${p.amount ? `: ${p.amount}` : ""}, vence el ${p.date}.`,
    payOverdue: (p) => `${p.kind}${p.amount ? `: ${p.amount}` : ""}, venció el ${p.date}. Responda este correo o llame para resolverlo.`,
    payNoDate: (p) => `${p.kind}${p.amount ? `: ${p.amount}` : ""}, fecha por confirmar.`,
    payAllPaid: "Todos los pagos registrados están al día. Gracias.",
    payGroupFinal: (date) => `El pago final vence el ${date}.`,
    payGroupDeposit: (date) => `El plazo del depósito es el ${date}.`,
    howToPay: "Los pagos los hace usted directamente a la naviera o al proveedor.",

    paperwork: "Documentos",
    paperworkCount: (p) => `Ha firmado ${p.signed} de ${p.total} documentos.`,
    paperworkToSign: "Falta firmar:",
    paperworkLink: "Fírmelos en su página privada de documentos",
    paperworkEnglishOnly: "Por ahora los documentos están en inglés.",
    paperworkDone: "Sus documentos están completos. Gracias.",

    passport: "Pasaportes",
    passportGeneral: "Cada viajero necesita un pasaporte vigente. Muchos países piden que siga vigente seis meses después del fin del viaje, y algunos itinerarios añaden requisitos de entrada propios. Consulte con la naviera y con el sitio web de viajes de su gobierno cuáles son las reglas para su ciudadanía y sus puertos.",
    passportBefore: (date) => `El pasaporte que tenemos en su archivo vence el ${date}, antes de que termine su crucero. Consulte con la naviera y renuévelo si es necesario.`,
    passportSoon: (date) => `El pasaporte que tenemos en su archivo vence el ${date}, menos de seis meses después de su regreso. Algunos países piden más que eso, así que conviene confirmarlo.`,
    passportFine: (date) => `El pasaporte que tenemos en su archivo vence el ${date}.`,

    insurance: "Seguro de viaje",
    insuranceOffer: `El seguro de viaje es opcional. Mark ofrece planes de Allianz. Responda este correo o llame al ${BUSINESS.phone} si desea una cotización o tiene preguntas.`,
    insuranceHave: "El seguro de viaje de su cabina figura como aceptado.",
    insuranceVideo: "Un video corto sobre cómo funciona:",

    checklist: "Su lista de tareas",
    checklistBy: (date) => `para el ${date}`,
    checklistEmpty: "No hay nada en su lista por ahora.",

    travel: "Cómo llegar al barco",
    travelOnFile: "Lo que tenemos de usted:",
    travelNeeded: "Todavía falta:",
    travelFlightIn: "Vuelo a la ciudad del puerto",
    travelFlightOut: "Vuelo de regreso",
    travelHotel: "Hotel antes del crucero",
    travelTransfer: "Traslado",
    travelOptional: "Si tiene hotel antes del crucero o un traslado al puerto, agréguelos también, con los números de confirmación.",
    travelAdd: "Agréguelo en la página de su crucero",
    travelFlightInNeed: "Su vuelo a la ciudad del puerto (número de vuelo, fecha y hora de llegada), o una nota de que viaja en auto o lo organiza por su cuenta",
    travelFlightOutNeed: "Su vuelo de regreso, o una nota de que viaja en auto o lo organiza por su cuenta",
    travelRow: (p) => `${p.kind}: ${p.what}`,

    missing: "Lo que todavía necesitamos",
    missingPaperwork: (n) => `Documentos: ${n} ${n === 1 ? "documento" : "documentos"} por firmar`,
    missingTravelIn: "Cómo llegará al puerto (vuelo, o una nota de que viaja en auto)",
    missingTravelOut: "Cómo regresará a casa (vuelo, o una nota de que viaja en auto)",
    missingEmergency: "Un contacto de emergencia (nombre y número de teléfono)",
    missingLink: "Agréguelo en la página de su crucero",

    deadlines: "Fechas de la naviera",
    deadlinesNote: "Estas fechas vienen de las condiciones de reserva de su naviera, con las palabras de la naviera (en inglés):",
    namesDue: (date) => `La naviera necesita los nombres de los pasajeros antes del ${date}. Sus documentos son lo que nos permite enviarlos.`,

    excursions: "Excursiones",
    excursionsLead: "Excursiones que vale la pena revisar para sus puertos:",
    dining: "Comidas y cambios",
    diningOnFile: (d) => `Comedor registrado para su cabina: ${d}.`,
    diningLead: "Fechas de las condiciones de la naviera (en inglés):",

    checkin: "Registro",
    checkinOpens: (date) => `El registro en línea abre el ${date}.`,
    checkinCloses: (date) => `El registro cierra el ${date}.`,
    checkinLine: "De las condiciones de la naviera (en inglés):",
    checkinGeneral: "Complete el registro en línea de la naviera antes de viajar. La naviera fija las fechas y aparecen en su reserva.",

    documents: "Documentos que debe llevar",
    docPassport: "Su pasaporte, uno por cada viajero",
    docBooking: (n) => `Su número de reserva: ${n}`,
    docBoarding: "Los documentos de embarque que la naviera emite al completar el registro, impresos o en su teléfono",
    docInsurance: "Los datos de su póliza de seguro de viaje, si compró un plan",
    docTravelRow: (p) => `${p.kind}: ${p.what}`,
    docVisa: "Si la naviera o un puerto exige una visa u otro documento de entrada, llévela. Consulte con la naviera y con el sitio web de viajes de su gobierno, porque las reglas dependen de su ciudadanía y de sus puertos.",

    packing: "Equipaje",
    packingLead: "La naviera publica lo que permite llevar a bordo. Revise su lista antes de empacar.",
    packingItems: "De su lista:",
    packingSite: "Qué ponerse y lo esencial para la cabina, en nuestro sitio:",
    packingWear: "Qué ponerse",
    packingCabin: "Esenciales para la cabina",
    packingBag: "En el equipaje de mano: pasaportes, medicinas, documentos de embarque, una muda de ropa y todo lo que no pueda reponer.",

    videos: "Videos de nuestro canal",
    videosLead: "Del canal de YouTube de Still Afloat Cruising:",

    ship: "Su barco",
    shipClass: (p) => `${p.ship} es un barco de la clase ${p.cls}.`,
    shipScore: (p) => `Nuestra puntuación Conga Line para ${p.ship}: ${p.score} de 5.`,
    shipTracker: (ship) => `Siga a ${ship || "su barco"} en nuestro rastreador de barcos`,
    shipBed: (b) => `Camas registradas: ${b}.`,

    embark1: "Día de embarque, primera parte",
    embarkPort: (p) => `Usted aborda en ${p.port}${p.date ? ` el ${p.date}` : ""}.`,
    embarkTerminal: "La terminal y su hora de embarque aparecen en los documentos que la naviera emite al completar el registro.",
    embarkSails: (time) => `El barco tiene programada su salida a las ${time}.`,
    embarkTold: (time) => `Usted nos indicó que piensa estar en el puerto alrededor de las ${time}.`,
    embarkTransfer: (p) => `Su traslado al puerto: ${p.what}`,
    embarkTags: "Ponga las etiquetas de equipaje que da la naviera en cada maleta antes de salir de casa o del hotel.",
    embarkCarry: "Lleve pasaportes, medicinas, documentos de embarque y objetos de valor en el equipaje de mano, no en las maletas que entrega.",
    embarkMuster: "Todos los pasajeros participan en el simulacro de seguridad (el muster) antes de que zarpe el barco. Escuche el anuncio y siga las instrucciones de la naviera.",
    embarkTermsLine: "De las condiciones de la naviera (en inglés):",
    embark2: "Día de embarque, segunda parte",
    embark2Window: "Muchas navieras asignan una ventana de embarque. Si la suya lo hizo, llegar a esa hora es más fácil que llegar temprano.",
    embark2Arrive: (time) => `Usted nos indicó que piensa llegar alrededor de las ${time}. Si cambia, actualícelo en la página de su crucero.`,

    weather: "Pronóstico para su crucero",
    weatherHead: ["Día", "Lugar", "Máx. / Mín.", "Cielo"],
    weatherNote: (date) => `Pronóstico al ${date}. Va a cambiar, así que vuelva a mirarlo el día antes de salir.`,
    weatherSample: "Solo vista previa: esta tabla usa el pronóstico real de hoy, movido a las fechas del viaje porque faltan más de diez días.",
    weatherCredit: "Datos del tiempo de Open-Meteo.com.",
    weatherTemp: (p) => `${p.high}° / ${p.low}°F`,
    storm: "Vigilancia de tormentas",
    stormLine: (p) => `Nuestra Vigilancia de Tormentas incluye a ${p.ship} entre los barcos a observar por ${p.kind}. Un barco en la lista es uno a observar, no uno que ya cambió de rumbo.`,
    stormLink: "Ver la Vigilancia de Tormentas",
    packTweaks: "Últimas notas para la maleta",
    tweakRain: "El pronóstico muestra chubascos: una chaqueta ligera para la lluvia o un paraguas pequeño.",
    tweakWarm: "Hará calor: protección solar, un sombrero y ropa ligera.",
    tweakCool: "Las noches pueden ser frescas: una capa ligera.",

    emergency: "Contacto de emergencia",
    emergencyOnFile: (p) => `Tenemos registrado: ${[p.name, p.phone].filter(Boolean).join(", ")}.`,
    emergencyNone: "No tenemos un contacto de emergencia registrado para usted.",
    emergencyChange: "Revíselo, o cámbielo, en la página de su crucero",

    booked: "Su reserva",
    signed: "Lo que ha firmado",
    signedRow: (p) => `${p.title}${p.date ? `, ${p.date}` : ""}`,
    signedNone: "Todavía no hay documentos firmados. Lo esperan en su página privada de documentos.",
    next: "Lo que sigue",
    nextRow: (p) => `${p.date}: ${p.what}`,
    nextTopics: {
      "t-120": "pagos y documentos", "t-90": "pago final y planes de viaje", "t-45": "excursiones y comidas",
      "t-20": "registro, documentos y equipaje", "t-10": "su barco y el día de embarque", "t-5": "el pronóstico del tiempo", "t-2": "registro y últimos detalles",
    },

    payment: "El pago",
    paymentOne: (p) => `${p.kind}: ${p.amount ? `${p.amount} ` : ""}vence el ${p.date}${p.cabin ? ` para ${p.cabin}` : ""}.`,
    howToPayTitle: "Cómo pagar",
    paymentNote: "Nota en el archivo:",

    change: "Qué cambió",
    changeFrom: "Antes",
    changeTo: "Ahora",
    changeLabel: "Detalle",
    changeNoteEs: "El mensaje de Mark está en inglés.",
  },

  hub: {
    title: "Su crucero",
    helloLead: (n) => (n ? `Hola ${n}.` : "Hola."),
    noticesTitle: "Cambios en su crucero",
    noticesEmpty: "",
    detailsTitle: "Cuéntenos cómo va a llegar",
    detailsLead: "Lo que agregue aquí pasa directamente a su archivo. Deje en blanco lo que no corresponda.",
    save: "Guardar",
    saved: "Guardado. Gracias.",
    saveFailed: "No se guardó. Revise las líneas marcadas abajo e intente de nuevo.",
    langSwitch: "English",
    tick: "Hecho",
    openPaperwork: "Abrir sus documentos",
    contactTitle: "Preguntas",
    sectionEmpty: "",
    badLink: "Este enlace no es válido. Verifique que abrió el enlace completo de su correo, o pida a Mark uno nuevo.",
    footer: BUSINESS.legalName,
    fields: {
      getting_there: "¿Cómo llegará al puerto?",
      getting_there_flying: "En avión",
      getting_there_driving: "En auto",
      getting_there_other: "De otra manera, o lo organizamos por nuestra cuenta",
      flight_in_flight: "Vuelo a la ciudad del puerto (aerolínea y número)",
      flight_in_date: "Fecha de llegada",
      flight_in_time: "Hora de llegada",
      flight_out_flight: "Vuelo de regreso (aerolínea y número)",
      flight_out_date: "Fecha de salida",
      flight_out_time: "Hora de salida",
      hotel_name: "Hotel antes del crucero",
      hotel_confirmation: "Número de confirmación del hotel",
      transfer_note: "Traslado al puerto (empresa y hora de recogida)",
      transfer_confirmation: "Número de confirmación del traslado",
      port_arrival_time: "Hora en que piensa estar en el puerto",
      emergency_name: "Nombre del contacto de emergencia",
      emergency_phone: "Teléfono del contacto de emergencia",
    },
  },

  err: {
    notFound: "Este enlace no es válido. Verifique que abrió el enlace completo de su correo, o pida a Mark uno nuevo.",
    tooMany: "Demasiados intentos. Intente más tarde, o llame a Mark.",
    badField: "Revise esta respuesta.",
    badDate: "Escriba una fecha real.",
    badTime: "Escriba una hora, por ejemplo 14:30.",
    badPhone: "Revise el número de teléfono.",
    card: "Aquí nunca se piden números de tarjeta. Quítelo, por favor.",
    tooLong: "Eso es demasiado largo.",
    needName: "Indique el nombre del contacto de emergencia.",
    needPhone: "Indique el teléfono del contacto de emergencia.",
  },
};

export const STRINGS: Record<Lang, Strings> = { en, es };
export const strings = (lang: Lang): Strings => STRINGS[lang === "es" ? "es" : "en"];

/** Spanish names for the weather codes the site uses (lib/weather-forecast.ts WEATHER_DESC is English). */
export const WEATHER_DESC_ES: Record<number, string> = {
  0: "cielo despejado", 1: "mayormente despejado", 2: "parcialmente nublado", 3: "nublado",
  45: "niebla", 48: "niebla con escarcha",
  51: "llovizna ligera", 53: "llovizna", 55: "llovizna fuerte",
  61: "lluvia ligera", 63: "lluvia", 65: "lluvia fuerte",
  71: "nieve ligera", 73: "nieve", 75: "nieve fuerte", 77: "granos de nieve",
  80: "chubascos ligeros", 81: "chubascos", 82: "chubascos fuertes",
  85: "chubascos de nieve", 86: "chubascos de nieve fuertes",
  95: "tormenta eléctrica", 96: "tormenta con granizo", 99: "tormenta severa",
};

/** The storm's class in the traveler's language (the alert text itself stays in English). */
export function stormKind(classification: string | null, name: string | null, lang: Lang): string {
  const c = (classification ?? "").trim();
  const n = (name ?? "").trim();
  const es: Record<string, string> = {
    "tropical storm": "la tormenta tropical", "hurricane": "el huracán", "tropical depression": "la depresión tropical",
    "gale warning": "una advertencia de vendaval", "post-tropical cyclone": "el ciclón postropical", "subtropical storm": "la tormenta subtropical",
  };
  const base = lang === "es" ? es[c.toLowerCase()] ?? (c ? `${c}` : "una tormenta") : (c || "a storm");
  return [base, n].filter(Boolean).join(" ");
}
