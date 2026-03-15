require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const healthRoutes = require('./routes/health');
const reportRoutes = require('./routes/reports');
const whatsappRoutes = require('./routes/whatsapp');
const aiProcessor = require('./services/ai-processor');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', healthRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/whatsapp', whatsappRoutes);

// Start AI processor (checks for unclassified reports every 30s)
aiProcessor.start();

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`CivicPulse API running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
});

module.exports = app;
