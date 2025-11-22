const mongoose = require('mongoose');

const earthquakeSchema = new mongoose.Schema({
  usgsId: {
    type: String,
    required: true,
    unique: true
  },
  magnitude: {
    type: Number,
    required: true
  },
  location: {
    type: String,
    required: true
  },
  latitude: {
    type: Number,
    required: true
  },
  longitude: {
    type: Number,
    required: true
  },
  depth: {
    type: Number,
    required: true
  },
  time: {
    type: Date,
    required: true
  },
  distanceFromDhaka: {
    type: Number
  },
  nearestCity: {
    type: String
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Earthquake', earthquakeSchema);