const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();

const Earthquake = require('./models/Earthquake');
const Subscriber = require('./models/Subscriber');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/dhakaquake', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Error:', err));

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

const bdCities = [
  { name: 'Dhaka', lat: 23.8103, lon: 90.4125 },
  { name: 'Chittagong', lat: 22.3569, lon: 91.7832 },
  { name: 'Sylhet', lat: 24.8949, lon: 91.8687 },
  { name: 'Rajshahi', lat: 24.3745, lon: 88.6042 },
  { name: 'Khulna', lat: 22.8456, lon: 89.5403 },
  { name: 'Cumilla', lat: 23.4607, lon: 91.1809 },
  { name: 'Rangpur', lat: 25.7439, lon: 89.2752 }
];

function findNearestCity(lat, lon) {
  let nearest = bdCities[0];
  let minDistance = calculateDistance(lat, lon, nearest.lat, nearest.lon);
  
  bdCities.forEach(city => {
    const distance = calculateDistance(lat, lon, city.lat, city.lon);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = city;
    }
  });
  
  return { name: nearest.name, distance: Math.round(minDistance) };
}

function getIntensityDescription(magnitude) {
  if (magnitude < 3.0) return 'Micro';
  if (magnitude < 4.0) return 'Minor';
  if (magnitude < 5.0) return 'Light';
  if (magnitude < 6.0) return 'Moderate';
  if (magnitude < 7.0) return 'Strong';
  if (magnitude < 8.0) return 'Major';
  return 'Great';
}

function getMercalliScale(magnitude) {
  if (magnitude < 3.0) return 'I-II';
  if (magnitude < 4.0) return 'III-IV';
  if (magnitude < 5.0) return 'V-VI';
  if (magnitude < 6.0) return 'VII-VIII';
  if (magnitude < 7.0) return 'IX-X';
  return 'XI-XII';
}

async function sendEmailAlert(earthquake) {
  try {
    const subscribers = await Subscriber.find({
      isActive: true,
      magnitudeThreshold: { $lte: earthquake.magnitude }
    });

    if (subscribers.length === 0) return;

    const emailPromises = subscribers.map(sub => {
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: sub.email,
        subject: `🚨 EARTHQUAKE ALERT: Magnitude ${earthquake.magnitude}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #292b2c; color: #f0f0f0; padding: 20px; border-radius: 10px;">
            <h2 style="color: #3491ff; text-align: center;">🚨 Earthquake Alert</h2>
            <div style="background: #555555; padding: 20px; border-radius: 8px; margin: 15px 0;">
              <p><strong>Magnitude:</strong> ${earthquake.magnitude}</p>
              <p><strong>Location:</strong> ${earthquake.location}</p>
              <p><strong>Nearest City:</strong> ${earthquake.nearestCity} (${earthquake.distanceFromDhaka} km)</p>
              <p><strong>Depth:</strong> ${earthquake.depth} km</p>
              <p><strong>Time:</strong> ${new Date(earthquake.time).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' })}</p>
            </div>
          </div>
        `
      };
      return transporter.sendMail(mailOptions);
    });

    await Promise.all(emailPromises);
    console.log(`📧 Sent ${subscribers.length} alerts`);
  } catch (error) {
    console.error('Email error:', error);
  }
}

async function checkEarthquakes() {
  try {
    console.log('🔍 Checking USGS for earthquakes...');
    
    // Fetch earthquakes from last 30 days (USGS free tier limit)
    // Note: USGS public API only provides last 30 days of data
    // For historical data (2000-today), would need paid API or manual import
    const response = await axios.get(
      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson',
      { timeout: 10000 }
    );

    const earthquakes = response.data.features;
    console.log(`📡 USGS returned ${earthquakes.length} total earthquakes worldwide`);
    
    // Filter for Bangladesh and nearby regions
    const bdEarthquakes = earthquakes.filter(quake => {
      const [lon, lat] = quake.geometry.coordinates;
      // Expanded region to catch more earthquakes
      return lat >= 18 && lat <= 29 && lon >= 86 && lon <= 95;
    });

    console.log(`📍 Found ${bdEarthquakes.length} earthquakes near Bangladesh region`);
    console.log(`ℹ️  Note: USGS free API provides last 30 days only`);

    let newCount = 0;
    let existingCount = 0;

    for (const quake of bdEarthquakes) {
      const usgsId = quake.id;
      
      // Check if already exists
      const existing = await Earthquake.findOne({ usgsId });
      if (existing) {
        existingCount++;
        continue;
      }

      const [lon, lat, depth] = quake.geometry.coordinates;
      const magnitude = quake.properties.mag;
      const location = quake.properties.place || 'Unknown location';
      const time = new Date(quake.properties.time);

      const nearestInfo = findNearestCity(lat, lon);

      const newEarthquake = new Earthquake({
        usgsId,
        magnitude,
        location,
        latitude: lat,
        longitude: lon,
        depth: Math.abs(depth) || 0,
        time,
        distanceFromDhaka: nearestInfo.distance,
        nearestCity: nearestInfo.name
      });

      await newEarthquake.save();
      newCount++;
      console.log(`✅ NEW: ${magnitude} mag near ${nearestInfo.name} at ${time.toLocaleString()}`);
      
      // Only send email for significant earthquakes (≥4.0)
      if (magnitude >= 4.0) {
        await sendEmailAlert(newEarthquake);
      }
    }

    console.log(`📊 Summary: ${newCount} new, ${existingCount} already in database`);
    
    if (newCount === 0 && bdEarthquakes.length === 0) {
      console.log('ℹ️ No earthquakes in Bangladesh region from USGS (last 30 days)');
    }
    
  } catch (error) {
    console.error('❌ USGS API Error:', error.message);
    if (error.code === 'ECONNABORTED') {
      console.error('⏱️ Request timeout - USGS might be slow');
    }
  }
}

cron.schedule('*/2 * * * *', () => {
  checkEarthquakes();
});

checkEarthquakes();

// ============= API ROUTES =============

app.get('/api/earthquakes', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const earthquakes = await Earthquake.find()
      .sort({ time: -1 })
      .limit(limit);
    res.json(earthquakes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/latest', async (req, res) => {
  try {
    const latest = await Earthquake.findOne().sort({ time: -1 });
    if (!latest) {
      return res.json({ status: 'safe', message: 'No recent earthquakes' });
    }
    
    const enrichedData = {
      ...latest.toObject(),
      intensity: getIntensityDescription(latest.magnitude),
      mercalli: getMercalliScale(latest.magnitude),
      hoursSince: ((Date.now() - latest.time) / (1000 * 60 * 60)).toFixed(1)
    };
    
    res.json(enrichedData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [weekData, monthData, allTime, todayData] = await Promise.all([
      Earthquake.find({ time: { $gte: weekAgo } }).sort({ time: -1 }),
      Earthquake.find({ time: { $gte: monthAgo } }).sort({ time: -1 }),
      Earthquake.countDocuments(),
      Earthquake.find({ 
        time: { 
          $gte: new Date(now.setHours(0, 0, 0, 0)) 
        } 
      }).sort({ time: -1 })
    ]);

    const weekMags = weekData.map(e => e.magnitude);
    const monthMags = monthData.map(e => e.magnitude);

    res.json({
      weekly: {
        count: weekData.length,
        average: weekMags.length ? (weekMags.reduce((a,b) => a+b, 0) / weekMags.length).toFixed(2) : 0,
        largest: weekMags.length ? Math.max(...weekMags) : 0,
        earthquakes: weekData
      },
      monthly: {
        count: monthData.length,
        average: monthMags.length ? (monthMags.reduce((a,b) => a+b, 0) / monthMags.length).toFixed(2) : 0,
        largest: monthMags.length ? Math.max(...monthMags) : 0
      },
      today: {
        count: todayData.length,
        earthquakes: todayData
      },
      allTime: allTime,
      subscribers: await Subscriber.countDocuments({ isActive: true })
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/timeline', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const earthquakes = await Earthquake.find({
      time: { $gte: startDate }
    }).sort({ time: 1 });

    const timeline = earthquakes.map(e => ({
      date: e.time.toISOString().split('T')[0],
      magnitude: e.magnitude,
      location: e.nearestCity
    }));

    res.json(timeline);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/subscribe', async (req, res) => {
  try {
    const { email, magnitudeThreshold } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const existing = await Subscriber.findOne({ email });
    if (existing) {
      existing.magnitudeThreshold = magnitudeThreshold || 4.0;
      existing.isActive = true;
      await existing.save();
      return res.json({ message: 'Subscription updated!', subscriber: existing });
    }

    const subscriber = new Subscriber({
      email,
      magnitudeThreshold: magnitudeThreshold || 4.0
    });

    await subscriber.save();
    res.status(201).json({ message: 'Successfully subscribed!', subscriber });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/unsubscribe', async (req, res) => {
  try {
    const { email } = req.body;
    const subscriber = await Subscriber.findOne({ email });
    
    if (!subscriber) {
      return res.status(404).json({ error: 'Email not found' });
    }

    subscriber.isActive = false;
    await subscriber.save();
    res.json({ message: 'Successfully unsubscribed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Force check USGS immediately (for testing/debugging)
app.get('/api/force-check', async (req, res) => {
  try {
    console.log('🔄 Manual USGS check triggered...');
    await checkEarthquakes();
    const count = await Earthquake.countDocuments();
    res.json({ 
      message: 'USGS check completed', 
      totalEarthquakes: count,
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 USGS monitoring active`);
});