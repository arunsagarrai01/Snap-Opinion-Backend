const mongoose = require('mongoose');

const CommentSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, maxlength: 500 },
  createdAt: { type: Date, default: Date.now },
  replies: [{
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, maxlength: 500 },
    createdAt: { type: Date, default: Date.now }
  }]
});

const PostSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  videoUrl: { type: String, required: true }, // Hosted location (S3 or /uploads)
  caption: { type: String, maxlength: 280 },
  hashtags: [{ type: String, lowercase: true, trim: true }],
  durationSec: { type: Number, required: true }, // encourage <= 60
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [CommentSchema],
  views: { type: Number, default: 0 },
  isPromoted: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Post', PostSchema);
