const express = require('express');
const morgan = require('morgan');
const path = require('path');

const app = express();
app.use(express.json());
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// IN-MEMORY DATA
// ============================================================

const AIRLINES = [
  { name: 'American Airlines', code: 'AA', aircraft: 'Boeing 737-800' },
  { name: 'Delta Air Lines', code: 'DL', aircraft: 'Airbus A320' },
  { name: 'United Airlines', code: 'UA', aircraft: 'Boeing 787' },
  { name: 'British Airways', code: 'BA', aircraft: 'Boeing 777' },
  { name: 'Emirates', code: 'EK', aircraft: 'Airbus A380' },
];

const ROUTES = [
  { origin: { code: 'JFK', city: 'New York' }, destination: { code: 'LAX', city: 'Los Angeles' }, durationMin: 360 },
  { origin: { code: 'LAX', city: 'Los Angeles' }, destination: { code: 'JFK', city: 'New York' }, durationMin: 330 },
  { origin: { code: 'SFO', city: 'San Francisco' }, destination: { code: 'ORD', city: 'Chicago' }, durationMin: 240 },
  { origin: { code: 'JFK', city: 'New York' }, destination: { code: 'LHR', city: 'London' }, durationMin: 420 },
  { origin: { code: 'DXB', city: 'Dubai' }, destination: { code: 'BOM', city: 'Mumbai' }, durationMin: 210 },
  { origin: { code: 'DEL', city: 'Delhi' }, destination: { code: 'BLR', city: 'Bangalore' }, durationMin: 150 },
  { origin: { code: 'BLR', city: 'Bangalore' }, destination: { code: 'DEL', city: 'Delhi' }, durationMin: 155 },
  { origin: { code: 'BOM', city: 'Mumbai' }, destination: { code: 'DXB', city: 'Dubai' }, durationMin: 200 },
];

// Generate seat map: 2 first rows, 6 business rows, 30 economy rows
function generateSeatMap() {
  const seats = [];
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (let row = 1; row <= 2; row++)
    for (let i = 0; i < 3; i++)
      seats.push({ seatNumber: `${row}${letters[i]}`, class: 'first', isBooked: false });
  for (let row = 3; row <= 8; row++)
    for (let i = 0; i < 4; i++)
      seats.push({ seatNumber: `${row}${letters[i]}`, class: 'business', isBooked: false });
  for (let row = 9; row <= 38; row++)
    for (let i = 0; i < 6; i++)
      seats.push({ seatNumber: `${row}${letters[i]}`, class: 'economy', isBooked: false });
  return seats;
}

// Seed flights for next 7 days
const flights = [];
let flightId = 1;

function seedFlights() {
  const now = Date.now();
  for (let day = 0; day < 7; day++) {
    for (const route of ROUTES) {
      const airline = AIRLINES[Math.floor(Math.random() * AIRLINES.length)];
      const departureTime = new Date(now + day * 86400000 + (6 + Math.floor(Math.random() * 14)) * 3600000);
      const arrivalTime = new Date(departureTime.getTime() + route.durationMin * 60000);
      const baseEconomy = 150 + Math.floor(Math.random() * 400);

      flights.push({
        _id: String(flightId++),
        flightNumber: `${airline.code}${100 + Math.floor(Math.random() * 900)}`,
        airline: airline.name,
        aircraft: airline.aircraft,
        origin: { ...route.origin, airport: `${route.origin.city} International` },
        destination: { ...route.destination, airport: `${route.destination.city} International` },
        departureTime,
        arrivalTime,
        duration: route.durationMin,
        price: {
          economy: baseEconomy,
          business: Math.round(baseEconomy * 2.8),
          first: Math.round(baseEconomy * 4.5),
        },
        seats: generateSeatMap(),
        status: 'scheduled',
      });
    }
  }
  console.log(`✅ Seeded ${flights.length} flights`);
}
seedFlights();

// In-memory bookings
const bookings = [];
let bookingId = 1;

function generateBookingReference() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let ref = '';
  for (let i = 0; i < 6; i++) ref += chars.charAt(Math.floor(Math.random() * chars.length));
  return ref;
}

// ============================================================
// API ROUTES
// ============================================================

app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date() })
);

// Search flights
app.get('/api/flights/search', (req, res) => {
  const { origin, destination, departureDate, passengers = 1, class: seatClass = 'economy' } = req.query;

  let results = [...flights];

  if (origin) results = results.filter((f) => f.origin.code === origin.toUpperCase());
  if (destination) results = results.filter((f) => f.destination.code === destination.toUpperCase());

  if (departureDate) {
    const target = new Date(departureDate).toISOString().slice(0, 10);
    results = results.filter(
      (f) => new Date(f.departureTime).toISOString().slice(0, 10) === target
    );
  }

  // Filter by availability
  results = results.filter((f) => {
    const available = f.seats.filter((s) => s.class === seatClass && !s.isBooked).length;
    return available >= Number(passengers);
  });

  results.sort((a, b) => new Date(a.departureTime) - new Date(b.departureTime));

  res.json({ success: true, count: results.length, flights: results.slice(0, 50) });
});

// Get flight detail
app.get('/api/flights/:id', (req, res) => {
  const flight = flights.find((f) => f._id === req.params.id);
  if (!flight) return res.status(404).json({ success: false, message: 'Flight not found' });
  res.json({ success: true, flight });
});

// Create booking
app.post('/api/bookings', (req, res) => {
  const { flightId, passengers, contactEmail, contactPhone } = req.body;

  if (!passengers?.length)
    return res.status(400).json({ success: false, message: 'At least one passenger required' });
  if (!contactEmail || !contactPhone)
    return res.status(400).json({ success: false, message: 'Contact email and phone required' });

  const flight = flights.find((f) => f._id === flightId);
  if (!flight) return res.status(404).json({ success: false, message: 'Flight not found' });

  // Validate seats
  let totalAmount = 0;
  for (const p of passengers) {
    const seat = flight.seats.find((s) => s.seatNumber === p.seatNumber);
    if (!seat) return res.status(400).json({ success: false, message: `Seat ${p.seatNumber} not found` });
    if (seat.isBooked) return res.status(400).json({ success: false, message: `Seat ${p.seatNumber} already booked` });
    if (seat.class !== p.class)
      return res.status(400).json({ success: false, message: `Seat ${p.seatNumber} class mismatch` });
    totalAmount += flight.price[p.class];
  }

  // Lock seats
  for (const p of passengers) {
    const seat = flight.seats.find((s) => s.seatNumber === p.seatNumber);
    seat.isBooked = true;
  }

  const booking = {
    _id: String(bookingId++),
    bookingReference: generateBookingReference(),
    flight: { ...flight, seats: undefined }, // don't ship full seat map
    flightId: flight._id,
    passengers,
    contactEmail,
    contactPhone,
    totalAmount,
    currency: 'USD',
    status: 'confirmed',
    paymentStatus: 'paid',
    bookedAt: new Date(),
  };
  bookings.push(booking);

  res.status(201).json({ success: true, booking });
});

// Get booking by reference
app.get('/api/bookings/:reference', (req, res) => {
  const booking = bookings.find(
    (b) => b.bookingReference === req.params.reference.toUpperCase()
  );
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  res.json({ success: true, booking });
});

// List all bookings (demo only — real app would filter by user)
app.get('/api/bookings', (req, res) => {
  res.json({ success: true, count: bookings.length, bookings });
});

// Cancel booking
app.put('/api/bookings/:id/cancel', (req, res) => {
  const booking = bookings.find((b) => b._id === req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  if (booking.status === 'cancelled')
    return res.status(400).json({ success: false, message: 'Already cancelled' });

  const flight = flights.find((f) => f._id === booking.flightId);
  if (flight) {
    for (const p of booking.passengers) {
      const seat = flight.seats.find((s) => s.seatNumber === p.seatNumber);
      if (seat) seat.isBooked = false;
    }
  }

  booking.status = 'cancelled';
  booking.paymentStatus = 'refunded';
  booking.cancelledAt = new Date();
  booking.cancellationReason = req.body?.reason || 'User requested';

  res.json({ success: true, message: 'Booking cancelled', booking });
});

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API 404
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: `Not found - ${req.originalUrl}` });
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Flight Booking running on http://localhost:${PORT}`);
});

const shutdown = (signal) => {
  console.log(`${signal} received. Shutting down...`);
  server.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
