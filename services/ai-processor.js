const Anthropic = require('@anthropic-ai/sdk').default;
const supabase = require('../lib/supabase');

let anthropic = null;

function getClient() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// Classify a photo using Claude Haiku Vision
async function classifyPhoto(imageUrl) {
  const client = getClient();
  if (!client) {
    console.log('AI: No Anthropic API key, skipping classification');
    return null;
  }

  try {
    // Fetch image - use Twilio auth if it's a Twilio URL
    const headers = {};
    if (imageUrl.includes('api.twilio.com')) {
      const credentials = Buffer.from(
        `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
      ).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    }

    const response = await fetch(imageUrl, { headers });
    if (!response.ok) {
      console.error(`AI: Failed to fetch image: ${response.status}`);
      return null;
    }
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mediaType = response.headers.get('content-type') || 'image/jpeg';

    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          {
            type: 'text',
            text: `Analyze this photo from a citizen civic reporting app in Vijayawada, India. Classify it into exactly ONE category and provide details.

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "category": "civic|traffic|dog|water|sanitation",
  "issue_type": "specific type like pothole, no_helmet, stray_pack, garbage_overflow, no_supply, etc",
  "severity": "low|medium|high|critical",
  "confidence": 0.0 to 1.0,
  "description_en": "One sentence description in English",
  "description_te": "One sentence description in Telugu",
  "vehicle_plate": "plate number if visible, null otherwise"
}

Categories:
- civic: pothole, road_crack, streetlight, road_damage, construction_hazard
- traffic: no_helmet, wrong_side, red_light, phone_driving, drunk_driving, triple_riding
- dog: stray_pack, aggressive_dog, injured_dog, bite_incident
- water: no_supply, pipe_leak, contamination, low_pressure
- sanitation: garbage_overflow, drain_overflow, open_dump, no_collection`
          }
        ],
      }],
    });

    const text = result.content[0].text.trim();

    // Parse JSON (handle potential markdown wrapping)
    const clean = text.replace(/```json\s?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      category: parsed.category || 'civic',
      issue_type: parsed.issue_type || 'unknown',
      severity: parsed.severity || 'medium',
      confidence: parseFloat(parsed.confidence) || 0.5,
      description: parsed.description_en || '',
      description_telugu: parsed.description_te || '',
      vehicle_plate: parsed.vehicle_plate || null,
    };
  } catch (err) {
    console.error('AI classification error:', err.message);
    return null;
  }
}

// Read number plate using PlateRecognizer
async function readPlate(imageUrl) {
  if (!process.env.PLATE_API_KEY) return null;

  try {
    const imageResponse = await fetch(imageUrl);
    const imageBuffer = await imageResponse.arrayBuffer();
    const base64 = Buffer.from(imageBuffer).toString('base64');

    const response = await fetch('https://api.platerecognizer.com/v1/plate-reader/', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.PLATE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        upload: base64,
        regions: ['in'],
      }),
    });

    const data = await response.json();

    if (data.results && data.results.length > 0) {
      const plate = data.results[0].plate.toUpperCase();
      const score = data.results[0].score;

      // Validate Indian plate format
      if (/^[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}$/.test(plate.replace(/\s/g, ''))) {
        return { plate, confidence: score };
      }
    }

    return null;
  } catch (err) {
    console.error('PlateRecognizer error:', err.message);
    return null;
  }
}

// Process unclassified reports
async function processQueue() {
  try {
    // Find reports that haven't been AI-classified yet
    const { data: reports, error } = await supabase
      .from('reports')
      .select('*')
      .eq('issue_type', 'unclassified')
      .not('photo_urls', 'is', null)
      .limit(3);

    if (error || !reports || reports.length === 0) return;

    console.log(`AI: Processing ${reports.length} unclassified reports`);

    for (const report of reports) {
      const photoUrl = report.photo_urls?.[0];
      if (!photoUrl) continue;

      // Classify with Claude Haiku
      const classification = await classifyPhoto(photoUrl);

      if (classification) {
        const updateData = {
          category: classification.category,
          issue_type: classification.issue_type,
          ai_type: classification.issue_type,
          ai_confidence: classification.confidence,
          ai_severity: classification.severity,
          description: classification.description,
          description_telugu: classification.description_telugu,
        };

        // If traffic violation, also try plate recognition
        if (classification.category === 'traffic') {
          const plateResult = await readPlate(photoUrl);
          if (plateResult) {
            updateData.vehicle_plate = plateResult.plate;
          } else if (classification.vehicle_plate) {
            updateData.vehicle_plate = classification.vehicle_plate;
          }
        }

        await supabase
          .from('reports')
          .update(updateData)
          .eq('id', report.id);

        console.log(`AI: Classified report ${report.report_number} as ${classification.category}/${classification.issue_type} (${(classification.confidence * 100).toFixed(0)}%)`);
      }
    }
  } catch (err) {
    console.error('AI processor error:', err.message);
  }
}

// Start the processor
let intervalId = null;

function start() {
  if (intervalId) return;

  console.log('AI Processor: Starting (every 30 seconds)');
  intervalId = setInterval(processQueue, 30 * 1000);

  // Run once immediately after 5 second delay
  setTimeout(processQueue, 5000);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { start, stop, classifyPhoto, readPlate };
