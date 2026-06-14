# Flusso Invio Notifiche Push

## Logica

L'algoritmo di controllo deve scorrere la collezione `users` e per ogni utente eseguire i seguenti passaggi:

1.  **Controllo Stato e Impostazioni:**
    *   Verificare che `water_settings.enabled` sia `true`.
    *   Verificare che `fcmToken` sia presente e non nullo.
    *   *Dettaglio:* Se uno di questi manca, l'utente viene saltato immediatamente.

2.  **Controllo Fascia Oraria:**
    *   Recuperare l'orario attuale del server (convertito nella timezone dell'utente se necessario).
    *   Confrontare l'ora attuale con `water_settings.startTime` e `water_settings.endTime` (formato HH:mm).
    *   *Dettaglio:* La notifica viene inviata solo se l'orario attuale è compreso tra l'inizio e la fine della giornata attiva dell'utente.

3.  **Verifica Scadenza `nextDrink`:**
    *   Controllare se `water_status.nextDrink` non è `null`.
    *   Confrontare `currentDateTime` con `nextDrink` (formato ISO 8601).
    *   **Condizione:** Se `currentDateTime >= nextDrink`, l'utente deve essere notificato.

4.  **Invio Notifica (FCM):**
    *   Utilizzare `fcmToken` per inviare il messaggio tramite Firebase Cloud Messaging.
    *   *Dettaglio:* Includere nel payload della notifica un titolo accattivante e il corpo del messaggio (es. "È ora di bere un bicchiere d'acqua!").

5.  **Post-Invio e Pulizia (Protezione Loop):**
    *   **Importante:** Dopo l'invio con successo, il campo `nextDrink` deve essere aggiornato o impostato a `null` (oppure marcato come "notificato") per evitare che la successiva chiamata all'API invii nuovamente la stessa notifica allo stesso utente.
    *   *Dettaglio:* Se FCM restituisce un errore di "token non valido", impostare il campo `fcmToken` dell'utente a `null` nel database.

## Trigger

Tutta la logica sopra descritta è esposta tramite un endpoint API dedicato (es. `POST /process-notifications`).
*   L'API può essere chiamata manualmente o da un servizio di scheduling esterno.
*   L'API restituirà un riepilogo delle notifiche inviate (es. numero di successi e fallimenti).
