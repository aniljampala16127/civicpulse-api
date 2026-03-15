const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// In-memory session store (photo + location pairing)
// In production, use Redis. For MVP, this works fine.
const sessions = new Map();
const SESSION_TTL = 10 * 60 * 1000; // 10 minutes

// Clean expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.timestamp > SESSION_TTL) sessions.delete(key);
  }
}, 5 * 60 * 1000);

// Helper: Send WhatsApp reply via Twilio
async function sendReply(to, body) {
  try {
    const twilio = require('twilio')(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    await twilio.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: to,
      body: body,
    });
  } catch (err) {
    console.error('Twilio send error:', err.message);
  }
}

// Helper: Create report when both photo + location are available
async function createReport(session, phone) {
  try {
    // Find or create user
    let userId = null;
    const cleanPhone = phone.replace('whatsapp:', '');

    const { data: existing } = await supabase
      .from('users')
      .select('id, total_points, report_count')
      .eq('phone', cleanPhone)
      .single();

    if (existing) {
      userId = existing.id;
    } else {
      const { data: newUser } = await supabase
        .from('users')
        .insert({ phone: cleanPhone, language: 'te' })
        .select('id')
        .single();
      userId = newUser?.id;
    }

    // Download photo from Twilio and upload to Supabase Storage
    let publicPhotoUrl = session.photoUrl;
    try {
      if (session.photoUrl && session.photoUrl.includes('api.twilio.com')) {
        const credentials = Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64');

        const imgResponse = await fetch(session.photoUrl, {
          headers: { 'Authorization': `Basic ${credentials}` },
        });

        if (imgResponse.ok) {
          const buffer = await imgResponse.arrayBuffer();
          const fileName = `reports/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;

          const { data: upload, error: uploadErr } = await supabase.storage
            .from('photos')
            .upload(fileName, Buffer.from(buffer), {
              contentType: imgResponse.headers.get('content-type') || 'image/jpeg',
              upsert: false,
            });

          if (!uploadErr && upload) {
            const { data: urlData } = supabase.storage
              .from('photos')
              .getPublicUrl(fileName);
            publicPhotoUrl = urlData.publicUrl;
            console.log('Photo uploaded to Supabase Storage:', publicPhotoUrl);
          }
        }
      }
    } catch (photoErr) {
      console.error('Photo upload error:', photoErr.message);
      // Keep original Twilio URL as fallback
    }

    // Reverse geocode to get ward/address/city
    let ward = null;
    let address = null;
    let city = 'unknown';
    try {
      const geoUrl = `https://nominatim.openstreetmap.org/reverse?lat=${session.latitude}&lon=${session.longitude}&format=json&zoom=16`;
      const geoRes = await fetch(geoUrl, {
        headers: { 'User-Agent': 'CivicPulse/1.0' },
      });
      const geoData = await geoRes.json();

      if (geoData.address) {
        ward = geoData.address.suburb || geoData.address.neighbourhood || geoData.address.city_district || null;
        address = geoData.display_name ? geoData.display_name.split(',').slice(0, 3).join(',').trim() : null;
        city = (geoData.address.city || geoData.address.town || geoData.address.county || 'unknown').toLowerCase();
      }
    } catch (geoErr) {
      console.error('Geocoding error:', geoErr.message);
    }

    // Create report
    const { data: report, error } = await supabase
      .from('reports')
      .insert({
        user_id: userId,
        category: 'civic',
        issue_type: 'unclassified',
        latitude: session.latitude,
        longitude: session.longitude,
        location: `POINT(${session.longitude} ${session.latitude})`,
        city: city,
        ward: ward,
        address: address,
        photo_urls: publicPhotoUrl ? [publicPhotoUrl] : [],
        status: 'open',
      })
      .select()
      .single();

    if (error) throw error;

    // Update user stats
    if (userId) {
      const newCount = (existing?.report_count || 0) + 1;
      const newPoints = (existing?.total_points || 0) + 5;
      await supabase
        .from('users')
        .update({ report_count: newCount, total_points: newPoints })
        .eq('id', userId);
    }

    return report;
  } catch (err) {
    console.error('Create report error:', err.message);
    return null;
  }
}

// POST /api/whatsapp/webhook — Twilio sends messages here
router.post('/webhook', async (req, res) => {
  try {
    const {
      From: from,
      Body: body,
      NumMedia: numMedia,
      MediaUrl0: mediaUrl,
      Latitude: latitude,
      Longitude: longitude,
    } = req.body;

    console.log(`WhatsApp from ${from}: media=${numMedia}, lat=${latitude}, body="${body?.substring(0, 50)}"`);

    const hasPhoto = parseInt(numMedia) > 0 && mediaUrl;
    const hasLocation = latitude && longitude;
    const sessionKey = from;

    // Get or create session
    let session = sessions.get(sessionKey) || { timestamp: Date.now() };

    // ─── PHOTO RECEIVED ───
    if (hasPhoto) {
      session.photoUrl = mediaUrl;
      session.timestamp = Date.now();
      sessions.set(sessionKey, session);

      if (session.latitude) {
        // Already have location → create report
        const report = await createReport(session, from);
        sessions.delete(sessionKey);

        if (report) {
          const num = String(report.report_number).padStart(5, '0');
          const locationName = report.ward || report.address?.split(',')[0] || 'Location received';
          await sendReply(from,
            `🎯 Report Submitted!\n\n` +
            `📋 Report: CP-${num}\n` +
            `📍 ${locationName}\n` +
            `🤖 AI is analyzing your photo...\n\n` +
            `+5 points earned!\n` +
            `ధన్యవాదాలు! 🌟`
          );
        }
      } else {
        // Need location
        await sendReply(from,
          `✅ Photo received!\n\n` +
          `📍 Now share your location:\n` +
          `Tap 📎 → Location → Send Current Location\n\n` +
          `లొకేషన్ షేర్ చేయండి 📍`
        );
      }

      return res.status(200).send('<Response></Response>');
    }

    // ─── LOCATION RECEIVED ───
    if (hasLocation) {
      session.latitude = parseFloat(latitude);
      session.longitude = parseFloat(longitude);
      session.timestamp = Date.now();
      sessions.set(sessionKey, session);

      if (session.photoUrl) {
        // Already have photo → create report
        const report = await createReport(session, from);
        sessions.delete(sessionKey);

        if (report) {
          const num = String(report.report_number).padStart(5, '0');
          const locationName = report.ward || report.address?.split(',')[0] || 'Location received';
          await sendReply(from,
            `🎯 Report Submitted!\n\n` +
            `📋 Report: CP-${num}\n` +
            `📍 ${locationName}\n` +
            `🤖 AI is analyzing your photo...\n\n` +
            `+5 points earned!\n` +
            `ధన్యవాదాలు! 🌟`
          );
        }
      } else {
        // Need photo
        await sendReply(from,
          `📍 Location received!\n\n` +
          `📸 Now send a photo of the issue:\n` +
          `Pothole, garbage, stray dogs, traffic violation...\n\n` +
          `ఫోటో పంపండి 📸`
        );
      }

      return res.status(200).send('<Response></Response>');
    }

    // ─── TEXT COMMANDS ───
    const text = (body || '').trim().toLowerCase();

    if (text === 'status') {
      const cleanPhone = from.replace('whatsapp:', '');
      const { data: user } = await supabase
        .from('users')
        .select('total_points, report_count, total_rewards')
        .eq('phone', cleanPhone)
        .single();

      if (user) {
        await sendReply(from,
          `📊 Your CivicPulse Stats:\n\n` +
          `📝 Reports: ${user.report_count}\n` +
          `⭐ Points: ${user.total_points}\n` +
          `💰 Rewards: ₹${user.total_rewards || 0}\n\n` +
          `Keep reporting! 💪`
        );
      } else {
        await sendReply(from,
          `No reports yet! Send a photo to get started. 📸`
        );
      }

      return res.status(200).send('<Response></Response>');
    }

    if (text === 'help' || text === 'hi' || text === 'hello') {
      await sendReply(from,
        `🙏 CivicPulse కి స్వాగతం!\n` +
        `Welcome to CivicPulse Vijayawada!\n\n` +
        `📸 Send a photo of any issue:\n` +
        `• Pothole, garbage, broken road\n` +
        `• Traffic violation (no helmet, wrong side)\n` +
        `• Stray dogs\n` +
        `• Water/drainage problem\n\n` +
        `AI will classify it automatically!\n\n` +
        `Commands:\n` +
        `• "status" — your reports & points\n` +
        `• "help" — this message\n\n` +
        `Just send a photo — no "Hi" needed! 📸`
      );

      return res.status(200).send('<Response></Response>');
    }

    // Unknown text
    await sendReply(from,
      `📸 Send a photo of any civic issue!\n` +
      `Or type "help" for more info.\n\n` +
      `ఫోటో పంపండి లేదా "help" టైప్ చేయండి`
    );

    res.status(200).send('<Response></Response>');
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(200).send('<Response></Response>');
  }
});

module.exports = router;
