const express = require('express');
const multer = require('multer');
const path = require('path');
const { body, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const Post = require('../models/Post');
const User = require('../models/User');

const router = express.Router();

// Configure multer for local uploads (change to S3 in production)
const uploadDir = process.env.UPLOAD_DIR || 'uploads';
const maxSizeMB = Number(process.env.MAX_VIDEO_SIZE_MB || 50);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: maxSizeMB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // accept video mime types commonly used, you can extend
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  }
});

// POST create a new post (multipart form-data: video + caption + durationSec + hashtags)
router.post(
  '/',
  auth,
  upload.single('video'),
  body('durationSec').isFloat({ gt: 0, lt: 300 }), // allow short durations, prefer <=60 but don't hard-block
  async (req, res) => {
    // validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If upload created file, you may want to delete it on error (not implemented here)
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      if (!req.file) return res.status(400).json({ error: 'Video file required' });

      const { caption = '', durationSec, hashtags = '' } = req.body;
      // Simple hashtag parsing (comma or space separated)
      const tags = typeof hashtags === 'string'
        ? hashtags.split(/[, ]+/).map(s => s.trim()).filter(Boolean)
        : Array.isArray(hashtags) ? hashtags : [];

      // videoUrl uses local path; in production you'd upload to S3 and store S3 URL
      const videoUrl = `${req.protocol}://${req.get('host')}/${process.env.UPLOAD_DIR || 'uploads'}/${req.file.filename}`;

      // prefer 60s or less - enforce if needed:
      const duration = Number(durationSec);
      // If you want to strictly enforce <=60s, uncomment:
      // if (duration > 60) return res.status(400).json({ error: 'Duration must be <= 60 seconds for SnapOpinion' });

      const post = await Post.create({
        author: req.user._id,
        videoUrl,
        caption,
        hashtags: tags,
        durationSec: duration
      });

      res.json({ post });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create post' });
    }
  }
);

// GET feed: pagination & optional hashtag filter
router.get('/', auth, async (req, res) => {
  const page = Math.max(0, Number(req.query.page || 0));
  const limit = Math.min(50, Number(req.query.limit || 12));
  const hashtag = req.query.hashtag;

  try {
    const filter = {};
    if (hashtag) filter.hashtags = hashtag.toLowerCase();

    // simple feed: newest first. Could be replaced by relevance algorithm
    const posts = await Post.find(filter)
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .populate('author', 'username displayName avatarUrl');

    res.json({ posts, page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

// GET single post (and increment view)
router.get('/:id', auth, async (req, res) => {
  try {
    const post = await Post.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true })
      .populate('author', 'username displayName avatarUrl')
      .populate('comments.author', 'username displayName');

    if (!post) return res.status(404).json({ error: 'Not found' });
    res.json({ post });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// Like / Unlike
router.post('/:id/like', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });

    const uid = req.user._id;
    const liked = post.likes.some(x => x.equals(uid));
    if (liked) {
      post.likes = post.likes.filter(x => !x.equals(uid));
    } else {
      post.likes.push(uid);
    }
    await post.save();
    res.json({ likesCount: post.likes.length, liked: !liked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
});

// Comment on post
router.post('/:id/comment', auth, [
  body('text').isLength({ min: 1, max: 500 })
], async (req, res) => {
  const errors = validationResult(req); if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });

    const comment = {
      author: req.user._id,
      text: req.body.text
    };
    post.comments.push(comment);
    await post.save();

    res.json({ comment: post.comments[post.comments.length - 1] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Reply to a comment (nested)
router.post('/:id/comment/:commentId/reply', auth, [
  body('text').isLength({ min: 1, max: 500 })
], async (req, res) => {
  const errors = validationResult(req); if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });

    const comment = post.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    comment.replies.push({
      author: req.user._id,
      text: req.body.text
    });

    await post.save();
    res.json({ reply: comment.replies[comment.replies.length - 1] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add reply' });
  }
});

// Simple follow/unfollow user
router.post('/user/:userId/follow', auth, async (req, res) => {
  try {
    const toFollow = await User.findById(req.params.userId);
    if (!toFollow) return res.status(404).json({ error: 'User not found' });
    const me = await User.findById(req.user._id);

    const alreadyFollowing = me.following.some(x => x.equals(toFollow._id));
    if (alreadyFollowing) {
      me.following = me.following.filter(x => !x.equals(toFollow._id));
      toFollow.followers = toFollow.followers.filter(x => !x.equals(me._id));
    } else {
      me.following.push(toFollow._id);
      toFollow.followers.push(me._id);
    }
    await me.save();
    await toFollow.save();

    res.json({ followingCount: me.following.length, followersCount: toFollow.followers.length, following: !alreadyFollowing });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to follow/unfollow' });
  }
});

module.exports = router;
