// BR SUBODH YT - Client-side JS

document.addEventListener('DOMContentLoaded', () => {
  // Star rating
  const starRating = document.getElementById('starRating');
  if (starRating) {
    const stars = starRating.querySelectorAll('i');
    const ratingInput = document.getElementById('ratingValue');
    
    function updateStars(val) {
      stars.forEach(s => s.classList.toggle('active', parseInt(s.dataset.value) <= val));
    }
    
    updateStars(5);
    
    stars.forEach(star => {
      star.addEventListener('click', () => {
        const val = parseInt(star.dataset.value);
        ratingInput.value = val;
        updateStars(val);
      });
      star.addEventListener('mouseenter', () => {
        const val = parseInt(star.dataset.value);
        stars.forEach(s => s.classList.toggle('active', parseInt(s.dataset.value) <= val));
      });
    });
    
    starRating.addEventListener('mouseleave', () => {
      updateStars(parseInt(ratingInput.value));
    });
  }
  
  // Feedback form
  const feedbackForm = document.getElementById('feedbackForm');
  if (feedbackForm) {
    feedbackForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(feedbackForm);
      const data = Object.fromEntries(formData);
      const refId = document.getElementById('feedbackRefId').value;
      const feedbackType = document.getElementById('feedbackType').value;
      
      let url = feedbackType === 'deposit' ? '/deposit/feedback' : '/purchase/feedback';
      let body = { ...data, [feedbackType === 'deposit' ? 'deposit_id' : 'purchase_id']: refId };
      
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': document.getElementById('csrfToken').value },
          body: JSON.stringify(body)
        });
        const result = await res.json();
        if (result.success) {
          showToast('Feedback submitted!', 'success');
          bootstrap.Modal.getInstance(document.getElementById('feedbackModal')).hide();
          setTimeout(() => location.reload(), 1000);
        } else {
          showToast(result.message, 'error');
        }
      } catch (err) {
        showToast('Error submitting feedback', 'error');
      }
    });
  }
  
  // Buy API buttons
  document.querySelectorAll('.btn-buy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const apiId = btn.dataset.id;
      const apiName = btn.dataset.name;
      const apiPrice = btn.dataset.price;
      
      if (!confirm(`Buy "${apiName}" for ₹${apiPrice}?`)) return;
      
      try {
        const res = await fetch(`/purchase/${apiId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': document.getElementById('csrfToken').value }
        });
        const result = await res.json();
        if (result.success) {
          showToast(result.message, 'success');
          setTimeout(() => location.reload(), 1000);
        } else {
          showToast(result.message, 'error');
        }
      } catch (err) {
        showToast('Purchase failed', 'error');
      }
    });
  });
  
  // Task completion buttons
  document.querySelectorAll('.btn-complete-task').forEach(btn => {
    btn.addEventListener('click', async () => {
      const taskId = btn.dataset.taskId;
      if (!confirm('Have you completed this task?')) return;
      
      try {
        const res = await fetch(`/task/complete/${taskId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': document.getElementById('csrfToken').value }
        });
        const result = await res.json();
        if (result.success) {
          showToast(result.message, 'success');
          btn.disabled = true;
          btn.textContent = 'Submitted';
        } else {
          showToast(result.message, 'error');
        }
      } catch (err) {
        showToast('Error submitting task', 'error');
      }
    });
  });
  
  // Registration OTP
  const sendOtpBtn = document.getElementById('sendOtpBtn');
  if (sendOtpBtn) {
    sendOtpBtn.addEventListener('click', async () => {
      const mobile = document.getElementById('regMobile').value;
      if (!mobile || mobile.length < 10) {
        showToast('Enter valid mobile number', 'error');
        return;
      }
      
      sendOtpBtn.disabled = true;
      sendOtpBtn.textContent = 'Sending...';
      
      try {
        const res = await fetch('/register/send-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': document.getElementById('csrfToken').value },
          body: JSON.stringify({ mobile })
        });
        const result = await res.json();
        if (result.success) {
          showToast('OTP sent! Check console for dev OTP.', 'success');
          document.getElementById('otpSection').style.display = 'block';
          document.getElementById('otpStatus').innerHTML = '<span style="color:var(--success);">OTP sent successfully</span>';
          if (result.devOtp) {
            document.getElementById('otpStatus').innerHTML += `<br><span style="color:var(--accent);">Dev OTP: ${result.devOtp}</span>`;
          }
        } else {
          showToast(result.message, 'error');
        }
      } catch (err) {
        showToast('Error sending OTP', 'error');
      }
      
      sendOtpBtn.disabled = false;
      sendOtpBtn.textContent = 'Send OTP';
    });
  }
  
  // Admin sidebar toggle
  const adminToggle = document.querySelector('.admin-toggle');
  const adminSidebar = document.querySelector('.admin-sidebar');
  if (adminToggle && adminSidebar) {
    document.addEventListener('click', (e) => {
      if (!adminSidebar.contains(e.target) && !adminToggle.contains(e.target)) {
        adminSidebar.classList.remove('open');
      }
    });
  }
  
  // Animate elements on scroll
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('animate-in');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  
  document.querySelectorAll('.api-card, .stat-card, .notif-item, .task-card').forEach(el => {
    observer.observe(el);
  });
  
  // Notification polling
  if (document.querySelector('.notif-btn')) {
    setInterval(async () => {
      try {
        const res = await fetch('/api/unread-count');
        const data = await res.json();
        const badge = document.querySelector('.notif-badge');
        if (data.count > 0) {
          if (badge) {
            badge.textContent = data.count;
            badge.style.display = 'flex';
          } else {
            const btn = document.querySelector('.notif-btn');
            const span = document.createElement('span');
            span.className = 'notif-badge';
            span.textContent = data.count;
            btn.appendChild(span);
          }
        } else if (badge) {
          badge.style.display = 'none';
        }
      } catch (e) {}
    }, 30000);
  }
});

// Open feedback modal
function openFeedbackModal(refId, type) {
  document.getElementById('feedbackRefId').value = refId;
  document.getElementById('feedbackType').value = type;
  new bootstrap.Modal(document.getElementById('feedbackModal')).show();
}

function openDepositFeedback() {
  // For home page - will need deposit_id from server
  showToast('Go to Profile to give deposit feedback', 'success');
}

function openPurchaseFeedback() {
  showToast('Go to Profile to give purchase feedback', 'success');
}

function showToast(message, type = 'success') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  
  const toast = document.createElement('div');
  toast.className = `custom-toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
