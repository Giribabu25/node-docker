require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

// ============================================================
// DATABASE CONNECTION
// ============================================================
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB error:', err.message);
    process.exit(1);
  }
}

// ============================================================
// MODELS
// ============================================================

// ---------- User ----------
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    phone: String,
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

const User = mongoose.model('User', userSchema);

// ---------- Flight ----------
const seatSchema = new mongoose.Schema({
  seatNumber: String,
  class: { type: String, enum: ['economy', 'business', 'first'] },
  isBooked: { type: Boolean, default: false },
  bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
});

const flightSchema = new mongoose.Schema(
  {
    flightNumber: { type: String, required: true, unique: true, uppercase: true },
    airline: { type: String, required: true },
    aircraft: { type: String, default: 'Boeing 737' },
    origin: {
      code: { type: String, required: true, uppercase: true },
      city: { type: String, required: true },
      airport: String,
    },
    destination: {
      code: { type: String, required: true, uppercase: true },
      city: { type: String, required: true },
      airport: String,
    },
    departureTime: { type: Date, required: true },
    arrivalTime: { type: Date, required: true },
    duration: Number,
    price: {
      economy: { type: Number, required: true },
      business: { type: Number, required: true },
      first: Number,
    },
    totalSeats: { type: Number, default: 180 },
    availableSeats: {
      economy: { type: Number, default: 150 },
      business: { type: Number, default: 24 },
      first: { type: Number, default: 6 },
    },
    seats: [seatSchema],
    status: {
      type: String,
      enum: ['scheduled', 'delayed', 'cancelled', 'completed'],
      default: 'scheduled',
    },
  },
  { timestamps: true }
);

flightSchema.index({ 'origin.code': 1, 'destination.code': 1, departureTime: 1 });

const Flight = mongoose.model('Flight', flightSchema);

// ---------- Booking ----------
const passengerSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  dateOfBirth: Date,
  passportNumber: String,
  nationality: String,
  seatNumber: { type: String, required: true },
  class: { type: String, enum: ['economy', 'business', 'first'], required: true },
});

const bookingSchema = new mongoose.Schema(
  {
    bookingReference: { type: String, required: true, unique: true, uppercase: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    flight: { type: mongoose.Schema.Types.ObjectId, ref: 'Flight', required: true },
    passengers: [passengerSchema],
    contactEmail: { type: String, required: true },
    contactPhone: { type: String, required: true },
    totalAmount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'cancelled', 'completed'],
      default: 'pending',
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'refunded', 'failed'],
      default: 'pending',
    },
    bookedAt: { type: Date, default: Date.now },
    cancelledAt: Date,
    cancellationReason: String,
  },
  { timestamps: true }
);

const Booking = mongoose.model('Booking', bookingSchema);

// ============================================================
// HELPERS
// ============================================================

function generateSeatMap() {
  const seats = [];
  const rows = ['A', 'B', 'C', 'D', 'E', 'F'];

  // First: rows 1-2 (3 seats)
  for (let row = 1; row <= 2; row++) {
    for (let i = 0; i < 3; i++) {
      seats.push({ seatNumber: `${row}${rows[i]}`, class: 'first', isBooked: false });
    }
  }
  // Business: rows 3-8 (4 seats)
  for (let row = 3; row <= 8; row++) {
    for (let i = 0; i < 4; i++) {
      seats.push({ seatNumber: `${row}${rows[i]}`, class: 'business', isBooked: false });
    }
  }
  // Economy: rows 9-38 (6 seats)
  for (let row = 9; row <= 38; row++) {
    for (let i = 0; i < 6; i++) {
      seats.push({ seatNumber: `${row}${rows[i]}`, class: 'economy', isBooked: false });
    }
  }
  return seats;
}

function generateBookingReference() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let ref = '';
  for (let i = 0; i < 6; i++) ref += chars.charAt(Math.floor(Math.random() * chars.length));
  return ref;
}

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

// ============================================================
// MIDDLEWARE
// ============================================================

const protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return res.status(401).json({ success: false, message: 'Not authorized' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id);
    if (!req.user) return res.status(401).json({ success: false, message: 'User not found' });
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ success: false, message: 'Admin access required' });
};

// ============================================================
// APP + MIDDLEWARE
// ============================================================

const app = express();

app.use(helmet({ contentSecurityPolicy: false })); // disable CSP so React CDN works
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));

app.use(
  '/api',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: 'Too many requests, try again later',
  })
);

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// AUTH ROUTES
// ============================================================

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'Missing fields' });
    if (await User.findOne({ email }))
      return res.status(400).json({ success: false, message: 'Email already registered' });

    const user = await User.create({ name, email, password, phone });
    res.status(201).json({
      success: true,
      token: signToken(user._id),
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    res.json({
      success: true,
      token: signToken(user._id),
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/auth/me', protect, (req, res) => res.json({ success: true, user: req.user }));

// ============================================================
// FLIGHT ROUTES
// ============================================================

app.get('/api/flights/search', async (req, res, next) => {
  try {
    const { origin, destination, departureDate, passengers = 1, class: seatClass } = req.query;
    const query = { status: { $ne: 'cancelled' } };

    if (origin) query['origin.code'] = origin.toUpperCase();
    if (destination) query['destination.code'] = destination.toUpperCase();

    if (departureDate) {
      const start = new Date(departureDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(departureDate);
      end.setHours(23, 59, 59, 999);
      query.departureTime = { $gte: start, $lte: end };
    }

    if (seatClass && ['economy', 'business', 'first'].includes(seatClass)) {
      query[`availableSeats.${seatClass}`] = { $gte: Number(passengers) };
    }

    const flights = await Flight.find(query).sort({ departureTime: 1 }).limit(50);
    res.json({ success: true, count: flights.length, flights });
  } catch (err) {
    next(err);
  }
});

app.get('/api/flights/:id/seats', async (req, res, next) => {
  try {
    const flight = await Flight.findById(req.params.id).select('seats');
    if (!flight) return res.status(404).json({ success: false, message: 'Flight not found' });
    res.json({ success: true, seats: flight.seats.filter((s) => !s.isBooked) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/flights/:id', async (req, res, next) => {
  try {
    const flight = await Flight.findById(req.params.id);
    if (!flight) return res.status(404).json({ success: false, message: 'Flight not found' });
    res.json({ success: true, flight });
  } catch (err) {
    next(err);
  }
});

app.post('/api/flights', protect, adminOnly, async (req, res, next) => {
  try {
    const payload = { ...req.body, seats: generateSeatMap() };
    const dep = new Date(payload.departureTime);
    const arr = new Date(payload.arrivalTime);
    payload.duration = Math.round((arr - dep) / 60000);
    const flight = await Flight.create(payload);
    res.status(201).json({ success: true, flight });
  } catch (err) {
    next(err);
  }
});

app.put('/api/flights/:id', protect, adminOnly, async (req, res, next) => {
  try {
    const flight = await Flight.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!flight) return res.status(404).json({ success: false, message: 'Flight not found' });
    res.json({ success: true, flight });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/flights/:id', protect, adminOnly, async (req, res, next) => {
  try {
    const flight = await Flight.findByIdAndDelete(req.params.id);
    if (!flight) return res.status(404).json({ success: false, message: 'Flight not found' });
    res.json({ success: true, message: 'Flight deleted' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// BOOKING ROUTES
// ============================================================

app.post('/api/bookings', protect, async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { flightId, passengers, contactEmail, contactPhone } = req.body;

    if (!passengers?.length)
      throw Object.assign(new Error('At least one passenger required'), { statusCode: 400 });

    const flight = await Flight.findById(flightId).session(session);
    if (!flight) throw Object.assign(new Error('Flight not found'), { statusCode: 404 });
    if (flight.status === 'cancelled')
      throw Object.assign(new Error('Flight is cancelled'), { statusCode: 400 });

    let totalAmount = 0;
    const seatNumbers = [];

    for (const p of passengers) {
      const seat = flight.seats.find((s) => s.seatNumber === p.seatNumber);
      if (!seat) throw Object.assign(new Error(`Seat ${p.seatNumber} not found`), { statusCode: 400 });
      if (seat.isBooked)
        throw Object.assign(new Error(`Seat ${p.seatNumber} already booked`), { statusCode: 400 });
      if (seat.class !== p.class)
        throw Object.assign(new Error(`Seat class mismatch`), { statusCode: 400 });

      const price = flight.price[p.class];
      if (!price) throw Object.assign(new Error('Price not configured'), { statusCode: 400 });
      totalAmount += price;
      seatNumbers.push(p.seatNumber);
    }

    for (const seatNumber of seatNumbers) {
      const passenger = passengers.find((p) => p.seatNumber === seatNumber);
      const result = await Flight.updateOne(
        { _id: flight._id, 'seats.seatNumber': seatNumber, 'seats.isBooked': false },
        {
          $set: { 'seats.$.isBooked': true, 'seats.$.bookedBy': req.user._id },
          $inc: { [`availableSeats.${passenger.class}`]: -1 },
        },
        { session }
      );
      if (result.modifiedCount === 0) {
        throw Object.assign(new Error(`Seat ${seatNumber} just got booked`), { statusCode: 409 });
      }
    }

    const [booking] = await Booking.create(
      [
        {
          bookingReference: generateBookingReference(),
          user: req.user._id,
          flight: flight._id,
          passengers,
          contactEmail,
          contactPhone,
          totalAmount,
          status: 'confirmed',
          paymentStatus: 'paid',
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    const populated = await Booking.findById(booking._id)
      .populate('flight')
      .populate('user', 'name email');

    res.status(201).json({ success: true, booking: populated });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    next(err);
  }
});

app.get('/api/bookings/my', protect, async (req, res, next) => {
  try {
    const bookings = await Booking.find({ user: req.user._id })
      .populate('flight')
      .sort({ createdAt: -1 });
    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    next(err);
  }
});

app.get('/api/bookings/:reference', protect, async (req, res, next) => {
  try {
    const booking = await Booking.findOne({
      bookingReference: req.params.reference.toUpperCase(),
      user: req.user._id,
    }).populate('flight');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    res.json({ success: true, booking });
  } catch (err) {
    next(err);
  }
});

app.put('/api/bookings/:id/cancel', protect, async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    if (booking.user.toString() !== req.user._id.toString() && req.user.role !== 'admin')
      return res.status(403).json({ success: false, message: 'Not authorized' });

    if (booking.status === 'cancelled')
      return res.status(400).json({ success: false, message: 'Already cancelled' });

    for (const passenger of booking.passengers) {
      await Flight.updateOne(
        { _id: booking.flight, 'seats.seatNumber': passenger.seatNumber },
        {
          $set: { 'seats.$.isBooked': false, 'seats.$.bookedBy': null },
          $inc: { [`availableSeats.${passenger.class}`]: 1 },
        }
      );
    }

    booking.status = 'cancelled';
    booking.paymentStatus = 'refunded';
    booking.cancelledAt = new Date();
    booking.cancellationReason = req.body.reason || 'User requested';
    await booking.save();

    res.json({ success: true, message: 'Booking cancelled', booking });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// HEALTH + SEED + ERROR HANDLER
// ============================================================

app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date() })
);

// Seed endpoint (dev only) — visit http://localhost:3000/api/seed
app.get('/api/seed', async (req, res, next) => {
  try {
    await Flight.deleteMany({});
    await User.deleteMany({});

    await User.create({
      name: 'Admin',
      email: 'admin@skybooker.com',
      password: 'admin123',
      role: 'admin',
    });

    const now = Date.now();
    const sample = [
      {
        flightNumber: 'AA101',
        airline: 'American Airlines',
        aircraft: 'Boeing 737-800',
        origin: { code: 'JFK', city: 'New York', airport: 'JFK International' },
        destination: { code: 'LAX', city: 'Los Angeles', airport: 'LAX International' },
        departureTime: new Date(now + 1 * 86400000),
        arrivalTime: new Date(now + 1 * 86400000 + 6 * 3600000),
        price: { economy: 299, business: 899, first: 1499 },
      },
      {
        flightNumber: 'DL202',
        airline: 'Delta Air Lines',
        aircraft: 'Airbus A320',
        origin: { code: 'LAX', city: 'Los Angeles', airport: 'LAX International' },
        destination: { code: 'JFK', city: 'New York', airport: 'JFK International' },
        departureTime: new Date(now + 2 * 86400000),
        arrivalTime: new Date(now + 2 * 86400000 + 5.5 * 3600000),
        price: { economy: 349, business: 999, first: 1699 },
      },
      {
        flightNumber: 'UA303',
        airline: 'United Airlines',
        aircraft: 'Boeing 787',
        origin: { code: 'SFO', city: 'San Francisco', airport: 'SFO International' },
        destination: { code: 'ORD', city: 'Chicago', airport: "O'Hare International" },
        departureTime: new Date(now + 3 * 86400000),
        arrivalTime: new Date(now + 3 * 86400000 + 4 * 3600000),
        price: { economy: 199, business: 699, first: 1199 },
      },
      {
        flightNumber: 'BA404',
        airline: 'British Airways',
        aircraft: 'Boeing 777',
        origin: { code: 'JFK', city: 'New York', airport: 'JFK International' },
        destination: { code: 'LHR', city: 'London', airport: 'Heathrow' },
        departureTime: new Date(now + 5 * 86400000),
        arrivalTime: new Date(now + 5 * 86400000 + 7 * 3600000),
        price: { economy: 599, business: 1899, first: 3499 },
      },
      {
        flightNumber: 'EK505',
        airline: 'Emirates',
        aircraft: 'Airbus A380',
        origin: { code: 'DXB', city: 'Dubai', airport: 'Dubai International' },
        destination: { code: 'BOM', city: 'Mumbai', airport: 'Chhatrapati Shivaji' },
        departureTime: new Date(now + 4 * 86400000),
        arrivalTime: new Date(now + 4 * 86400000 + 3.5 * 3600000),
        price: { economy: 249, business: 799, first: 1499 },
      },
    ];

    for (const f of sample) {
      const dep = new Date(f.departureTime);
      const arr = new Date(f.arrivalTime);
      f.duration = Math.round((arr - dep) / 60000);
      f.seats = generateSeatMap();
      await Flight.create(f);
    }

    const count = await Flight.countDocuments();
    res.json({ success: true, message: `Seeded ${count} flights + admin user` });
  } catch (err) {
    next(err);
  }
});

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 for API
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: `Not found - ${req.originalUrl}` });
});

// Global error handler
app.use((err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Server Error';

  if (err.name === 'CastError') {
    message = 'Resource not found';
    statusCode = 404;
  }
  if (err.code === 11000) {
    message = `Duplicate field: ${Object.keys(err.keyValue).join(', ')}`;
    statusCode = 400;
  }
  if (err.name === 'ValidationError') {
    message = Object.values(err.errors).map((e) => e.message).join(', ');
    statusCode = 400;
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ============================================================
// SERVER START
// ============================================================

const PORT = process.env.PORT || 3000;

(async () => {
  await connectDB();

  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🌱 Seed data: http://localhost:${PORT}/api/seed`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received. Shutting down...`);
    server.close(() => {
      mongoose.connection.close(false, () => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
