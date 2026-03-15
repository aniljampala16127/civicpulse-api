const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

router.get('/health', async (req, res) => {
  try {
    const { count } = await supabase
      .from('reports')
      .select('*', { count: 'exact', head: true });

    res.json({
      status: 'ok',
      service: 'civicpulse-api',
      version: '1.0.0',
      database: 'connected',
      reports_count: count,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      message: err.message,
    });
  }
});

module.exports = router;
