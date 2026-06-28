const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

// Configurazione "intelligente" di Firebase
const serviceAccountPath = path.join(__dirname, 'chiave_admin.json');

try {
  if (fs.existsSync(serviceAccountPath)) {
    // 1. AMBIENTE LOCALE: Se il file esiste (sul tuo PC), usalo.
    console.log("Inizializzazione Firebase con file chiave_admin.json locale.");
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    // 2. CLOUD RUN: Se il file non c'è (su GitHub/Cloud Run), usa le credenziali predefinite.
    console.log("Inizializzazione Firebase con Application Default Credentials (Cloud Run).");
    admin.initializeApp();
  }
} catch (error) {
  console.error("ERRORE CRITICO INIZIALIZZAZIONE FIREBASE:", error);
  // Non blocchiamo l'avvio del server, così possiamo almeno rispondere agli endpoint di health check
}

const db = admin.firestore();
const fcm = admin.messaging();

app.use(express.json());

/**
 * Funzione di utilità per verificare se un utente deve ricevere la notifica ora.
 */
function shouldNotifyUser(user) {
  const now = new Date();
  
  // 1. Controllo abilitazione, presenza token e se è già scaduto/notificato
  if (!user.water_settings?.enabled || !user.fcmToken) {
    return { shouldNotify: false, reason: 'Disabilitato o manca token' };
  }

  if (user.fcmExpired === true) {
    return { shouldNotify: false, reason: 'Token marcato come scaduto (fcmExpired)' };
  }

  if (user.water_status?.notified === true) {
    return { shouldNotify: false, reason: 'Utente già notificato per questo ciclo' };
  }

  // 2. Controllo fascia oraria (HH:mm) convertito nella timezone dell'utente
  const timezone = user.timezone || 'Europe/Rome';
  let currentTimeStr;
  try {
    const formatter = new Intl.DateTimeFormat('it-IT', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(now);
    const hour = parts.find(p => p.type === 'hour').value;
    const minute = parts.find(p => p.type === 'minute').value;
    currentTimeStr = `${hour}:${minute}`;
  } catch (error) {
    // Fallback in caso di timezone non supportata
    const currentHour = now.getHours().toString().padStart(2, '0');
    const currentMinute = now.getMinutes().toString().padStart(2, '0');
    currentTimeStr = `${currentHour}:${currentMinute}`;
  }

  const { startTime, endTime } = user.water_settings || {};
  if (startTime && endTime) {
    if (currentTimeStr < startTime || currentTimeStr > endTime) {
      return { shouldNotify: false, reason: `Fuori fascia oraria (${startTime}-${endTime}) nella timezone ${timezone}` };
    }
  }

  // 3. Controllo nextDrink
  if (!user.water_status?.nextDrink) {
    return { shouldNotify: false, reason: 'nextDrink non impostato' };
  }

  const nextDrinkDate = new Date(user.water_status.nextDrink);
  if (now < nextDrinkDate) {
    return { shouldNotify: false, reason: `Non ancora scaduto (prossimo: ${user.water_status.nextDrink})` };
  }

  return { shouldNotify: true };
}

// Endpoint principale per processare le notifiche
app.post('/process-notifications', async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    const notificationQueue = [];

  

    usersSnapshot.forEach(doc => {
      const userData = doc.data();
      const check = shouldNotifyUser(userData);
          
      if (check.shouldNotify) {
        notificationQueue.push({
          id: doc.id,
          token: userData.fcmToken,
          name: userData.name || 'Utente',
          frequency: userData.water_settings?.frequency
        });
      }
    });

    console.log(`[Process] Trovati ${notificationQueue.length} utenti da notificare.`);

    const results = {
      success: 0,
      failure: 0,
      details: []
    };

    // --- PASSO 4 & 5: Invio e Aggiornamento ---
    for (const user of notificationQueue) {
      // Struttura richiesta dall'utente (FCM V1 style)
      const message = {
        token: user.token,
        notification: {
          title: 'Promemoria Idratazione 💧',
          body: `Ciao ${user.name}, è ora di bere un bicchiere d'acqua!`
        },
        data: {
          utenteId: user.id,
          tipo: 'idratazione'
        }
        /*,
        webpush: {
          notification: {
            icon: 'https://tuo-sito.it/icona-acqua.png', 
          }
        }*/
      };

      console.log(`[FCM] Invio notifica a ${user.id}...`);
      console.log("Payload inviato:", JSON.stringify(message));

      try {
        // Nota: admin.messaging().send(message) accetta l'oggetto senza il wrapper "message" esterno
        const response = await fcm.send(message);
        results.success++;
        
        // Calcola il prossimo drink time (ora di invio + frequenza in minuti)
        const frequencyMin = parseInt(user.frequency, 10) || 60; // fallback a 60 min se manca la frequenza
        const nextDrinkDate = new Date(Date.now() + frequencyMin * 60 * 1000);
        const nextDrinkStr = nextDrinkDate.toISOString();

        // MARCA COME NOTIFICATO E IMPOSTA IL PROSSIMO CONTROLLO
        await db.collection('users').doc(user.id).update({
          'water_status.notified': false, // resettato a false per il prossimo ciclo
          'water_status.lastNotifiedAt': admin.firestore.FieldValue.serverTimestamp(),
          'water_status.nextDrink': nextDrinkStr
        });

        results.details.push({ id: user.id, status: 'sent', messageId: response });
      } catch (error) {
        results.failure++;
        
        // GESTIONE TOKEN SCADUTO
        if (error.code === 'messaging/registration-token-not-registered' || 
            error.code === 'messaging/invalid-registration-token') {
          await db.collection('users').doc(user.id).update({
            fcmToken: null,
            fcmExpired: true
          });
          results.details.push({ id: user.id, status: 'token_expired', error: error.code });
        } else {
          results.details.push({ id: user.id, status: 'error', error: error.code });
        }
        console.error(`Errore invio a ${user.id}:`, error);
      }
    }

    res.json({
      status: 'completed',
      summary: {
        totalProcessed: notificationQueue.length,
        sent: results.success,
        failed: results.failure
      },
      results: results.details
    });

  } catch (error) {
    console.error('Errore durante il processamento notifiche:', error);
    res.status(500).json({ error: 'Errore interno al server' });
  }
});

// Endpoint per recuperare tutti gli utenti
app.get('/users', async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    const users = [];
    
    usersSnapshot.forEach(doc => {
      users.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json(users);
  } catch (error) {
    console.error('Errore durante il recupero degli utenti:', error);
    res.status(500).json({ error: 'Errore durante la lettura del database' });
  }
});

app.get('/hello', (req, res) => {
  res.json({ 
    message: 'Hello World! L\'API è attiva e funzionante.',
    timestamp: new Date().toISOString(),
    environment: process.env.K_SERVICE ? 'Cloud Run' : 'Local'
  });
});

app.get('/', (req, res) => {
  res.json({ message: 'Microservizio attivo con logica notifiche completa' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Microservice listening at http://0.0.0.0:${port}`);
});

module.exports = { shouldNotifyUser, app };
