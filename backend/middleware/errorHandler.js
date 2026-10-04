// Global error handler
const errorHandler = (err, req, res, next) => {
  console.error('[ERROR]', err);


  if (err.number) {
    if (err.number === 2627 || err.number === 2601) {
      return res.status(409).json({ success: false, message: 'Duplicate entry. Record already exists.' });
    }
    if (err.number === 547) {
      return res.status(400).json({ success: false, message: 'Foreign key constraint violated.' });
    }
    if (err.number === 515) {
      return res.status(400).json({ success: false, message: 'Required field is missing.' });
    }
  }

  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

// 404 handler
const notFound = (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found.` });
};

module.exports = { errorHandler, notFound };
