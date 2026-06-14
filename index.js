const express = require('express');
const admin = require('firebase-admin');
const serviceAccount = require('./chiave_admin.json');

const app = express();
const port = process.env.PORT || 3000;

// Inizializzazione Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

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

  // 2. Controllo fascia oraria (HH:mm)
  const currentHour = now.getHours().toString().padStart(2, '0');
  const currentMinute = now.getMinutes().toString().padStart(2, '0');
  const currentTimeStr = `${currentHour}:${currentMinute}`;

  const { startTime, endTime } = user.water_settings;
  if (startTime && endTime) {
    if (currentTimeStr < startTime || currentTimeStr > endTime) {
      return { shouldNotify: false, reason: `Fuori fascia oraria (${startTime}-${endTime})` };
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
          name: userData.name || 'Utente'
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
      const message = {
        notification: {
          title: 'Promemoria Idratazione 💧',
          body: `Ciao ${user.name}, è ora di bere un bicchiere d'acqua!`
        },
        token: user.token
      };

      try {
        const response = await fcm.send(message);
        results.success++;
        
        // MARCA COME NOTIFICATO
        await db.collection('users').doc(user.id).update({
          'water_status.notified': true,
          'water_status.lastNotifiedAt': admin.firestore.FieldValue.serverTimestamp()
        });

        results.details.push({ id: user.id, status: 'sent', messageId: response });
      } catch (error) {
        results.failure++;
        
        // GESTIONE TOKEN SCADUTO
        if (error.code === 'messaging/registration-token-not-registered' || 
            error.code === 'messaging/invalid-registration-token') {
          await db.collection('users').doc(user.id).update({
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

app.get('/', (req, res) => {
  res.json({ message: 'Microservizio attivo con logica notifiche completa' });
});

app.listen(port, () => {
  console.log(`Microservice listening at http://localhost:${port}`);
});
