# Feature: Cron Scheduler Interno per Notifiche Push 💧⏰

Questo documento definisce il funzionamento e l'architettura dello scheduler (Cron) interno introdotto nel microservizio per automatizzare l'invio periodico dei promemoria di idratazione.

---

## 📌 Obiettivo
Automatizzare l'invio dei promemoria senza dipendere da servizi di crontab o scheduler di terze parti esterni (come Google Cloud Scheduler o cronjob di sistema), rendendo il microservizio completamente autonomo.

---

## 🏗️ Architettura del Flusso

Il flusso viene riorganizzato estraendo la logica di business dall'endpoint HTTP per poterla eseguire sia tramite chiamata API che tramite timer periodico.

```mermaid
graph TD
    A[Inizio Ciclo] --> B{Trigger?}
    B -- Timer Interno (setInterval) --> C[Funzione processNotifications]
    B -- Richiesta HTTP (POST /process-notifications) --> C
    C --> D[Lettura Utenti da Firestore]
    D --> E[Filtro con shouldNotifyUser]
    E --> F[Invio Notifiche tramite FCM]
    F --> G[Aggiornamento Firestore (nextDrink e notified)]
    G --> H[Fine Ciclo / Risposta API]
```

---

## ⚙️ Dettagli di Implementazione

### 1. Estrazione del Core (`processNotifications`)
La logica precedentemente definita all'interno dell'endpoint `POST /process-notifications` viene incapsulata in una funzione asincrona riutilizzabile:
```javascript
async function processNotifications() {
  // 1. Legge gli utenti
  // 2. Filtra chi deve essere notificato
  // 3. Invia notifiche FCM
  // 4. Calcola il prossimo nextDrink (current time + frequency)
  // 5. Aggiorna i dati nel database
  // Ritorna un riepilogo (successi, fallimenti, dettagli)
}
```

### 2. Il Timer Periodico (`setInterval`)
Per avviare lo scheduler all'avvio dell'applicazione, viene impostato un timer nativo di Node.js.

* **Intervallo di controllo:** 1 minuto (`60000` ms) di default, configurabile tramite variabile d'ambiente.
* **Variabile d'ambiente per disattivazione:** È utile poter disattivare il cron interno (ad esempio in ambiente di testing o se si vuole usare uno scheduler esterno in produzione) tramite la variabile `DISABLE_INTERNAL_CRON`.

```javascript
const CRON_INTERVAL = process.env.CRON_INTERVAL_MS || 60000; // default 1 minuto
const DISABLE_CRON = process.env.DISABLE_INTERNAL_CRON === 'true';

if (!DISABLE_CRON) {
  console.log(`[Cron] Scheduler avviato con intervallo di ${CRON_INTERVAL}ms`);
  setInterval(async () => {
    console.log(`[Cron] Avvio controllo periodico...`);
    try {
      const summary = await processNotifications();
      console.log(`[Cron] Completato. Inviate: ${summary.summary.sent}, Fallite: ${summary.summary.failed}`);
    } catch (error) {
      console.error(`[Cron] Errore durante l'esecuzione:`, error);
    }
  }, CRON_INTERVAL);
} else {
  console.log(`[Cron] Scheduler interno disabilitato via variabile d'ambiente.`);
}
```

---

## 🛠️ Configurazione (Variabili d'Ambiente)

| Variabile | Tipo | Default | Descrizione |
| :--- | :--- | :--- | :--- |
| `CRON_INTERVAL_MS` | `Number` | `60000` | Frequenza con cui lo scheduler esegue il controllo degli utenti (in millisecondi). |
| `DISABLE_INTERNAL_CRON` | `Boolean` | `false` | Se impostato a `true`, lo scheduler interno non viene avviato. |
