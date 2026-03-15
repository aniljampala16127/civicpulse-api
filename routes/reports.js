const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET /api/reports — List all reports with filters
router.get('/', async (req, res) => {
  try {
    const { category, ward, status, city, limit } = req.query;

    let query = supabase
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(parseInt(limit) || 50);

    if (category && category !== 'all') query = query.eq('category', category);
    if (ward) query = query.eq('ward', ward);
    if (status) query = query.eq('status', status);
    if (city) query = query.eq('city', city);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reports/stats — Dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const city = req.query.city || 'vijayawada';

    const { data: all } = await supabase
      .from('reports')
      .select('status, category, donation_raised, upvotes')
      .eq('city', city);

    const total = all?.length || 0;
    const resolved = all?.filter(r => r.status === 'resolved').length || 0;
    const inProgress = all?.filter(r => r.status === 'in_progress').length || 0;
    const totalDonated = all?.reduce((sum, r) => sum + (parseFloat(r.donation_raised) || 0), 0) || 0;
    const totalUpvotes = all?.reduce((sum, r) => sum + (r.upvotes || 0), 0) || 0;

    // Category breakdown
    const categories = {};
    all?.forEach(r => {
      categories[r.category] = (categories[r.category] || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        total, resolved, inProgress,
        open: total - resolved - inProgress,
        resolutionRate: total > 0 ? ((resolved / total) * 100).toFixed(1) : 0,
        totalDonated, totalUpvotes, categories,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reports/geojson — GeoJSON for map
router.get('/geojson', async (req, res) => {
  try {
    const city = req.query.city || 'vijayawada';

    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .eq('city', city)
      .not('latitude', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;

    const geojson = {
      type: 'FeatureCollection',
      features: data.map(r => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [parseFloat(r.longitude), parseFloat(r.latitude)],
        },
        properties: {
          id: r.id,
          report_number: r.report_number,
          category: r.category,
          issue_type: r.issue_type,
          description: r.description,
          status: r.status,
          ward: r.ward,
          upvotes: r.upvotes,
          photo_urls: r.photo_urls,
          ai_confidence: r.ai_confidence,
          vehicle_plate: r.vehicle_plate,
          donation_raised: r.donation_raised,
          donation_goal: r.donation_goal,
          created_at: r.created_at,
        },
      })),
    };

    res.json(geojson);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/reports/:id — Single report
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Report not found' });

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/reports — Create new report (from WhatsApp bot or direct)
router.post('/', async (req, res) => {
  try {
    const {
      user_phone, category, issue_type, description,
      latitude, longitude, ward, photo_urls,
      vehicle_plate, city
    } = req.body;

    // Find or create user
    let userId = null;
    if (user_phone) {
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('phone', user_phone)
        .single();

      if (existingUser) {
        userId = existingUser.id;
      } else {
        const { data: newUser } = await supabase
          .from('users')
          .insert({ phone: user_phone })
          .select('id')
          .single();
        userId = newUser?.id;
      }
    }

    // Create report
    const reportData = {
      user_id: userId,
      category: category || 'civic',
      issue_type: issue_type || 'unclassified',
      description: description || null,
      latitude: latitude ? parseFloat(latitude) : null,
      longitude: longitude ? parseFloat(longitude) : null,
      location: latitude && longitude
        ? `POINT(${parseFloat(longitude)} ${parseFloat(latitude)})`
        : null,
      ward: ward || null,
      city: city || 'vijayawada',
      photo_urls: photo_urls || [],
      vehicle_plate: vehicle_plate || null,
      status: 'open',
    };

    const { data, error } = await supabase
      .from('reports')
      .insert(reportData)
      .select()
      .single();

    if (error) throw error;

    // Update user report count
    if (userId) {
      await supabase.rpc('increment_user_points', {
        user_id_input: userId,
        points_to_add: 5,
      }).catch(() => {
        // RPC might not exist yet, that's ok
        supabase
          .from('users')
          .update({
            report_count: supabase.raw('report_count + 1'),
            total_points: supabase.raw('total_points + 5'),
          })
          .eq('id', userId)
          .then(() => {});
      });
    }

    res.status(201).json({
      success: true,
      data,
      report_number: data.report_number,
      message: `Report CP-${String(data.report_number).padStart(5, '0')} created`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/reports/:id — Update report status
router.patch('/:id', async (req, res) => {
  try {
    const { status, resolved_photo_urls } = req.body;

    const updateData = { updated_at: new Date().toISOString() };
    if (status) updateData.status = status;
    if (resolved_photo_urls) updateData.resolved_photo_urls = resolved_photo_urls;

    const { data, error } = await supabase
      .from('reports')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/reports/:id/upvote — Upvote a report
router.post('/:id/upvote', async (req, res) => {
  try {
    const { data: report } = await supabase
      .from('reports')
      .select('upvotes')
      .eq('id', req.params.id)
      .single();

    if (!report) return res.status(404).json({ success: false, error: 'Not found' });

    const { data, error } = await supabase
      .from('reports')
      .update({ upvotes: (report.upvotes || 0) + 1 })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, upvotes: data.upvotes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
