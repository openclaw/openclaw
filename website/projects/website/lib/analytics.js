// Google Analytics 事件追蹤函式

/**
 * 發送自訂事件到 GA4
 */
export const trackEvent = (eventName, eventParams) => {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', eventName, eventParams);
  }
};

/**
 * 追蹤頁面瀏覽
 */
export const trackPageView = (url) => {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('config', process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID, {
      page_path: url,
    });
  }
};

/**
 * 電子商務事件:查看課程
 */
export const trackViewCourse = (course) => {
  trackEvent('view_item', {
    currency: 'TWD',
    value: course.price,
    items: [
      {
        item_id: course.id,
        item_name: course.name,
        item_category: course.category,
        price: course.price,
      },
    ],
  });
};

/**
 * 電子商務事件:加入購物車(點擊報名)
 */
export const trackAddToCart = (course) => {
  trackEvent('add_to_cart', {
    currency: 'TWD',
    value: course.price,
    items: [
      {
        item_id: course.id,
        item_name: course.name,
        item_category: course.category,
        item_variant: course.variant === 'group' ? '小班制' : '一對一',
        price: course.price,
      },
    ],
  });
};

/**
 * 電子商務事件:開始結帳
 */
export const trackBeginCheckout = (course) => {
  trackEvent('begin_checkout', {
    currency: 'TWD',
    value: course.price,
    items: [
      {
        item_id: course.id,
        item_name: course.name,
        item_category: course.category,
        item_variant: course.variant === 'group' ? '小班制' : '一對一',
        price: course.price,
      },
    ],
  });
};

/**
 * 電子商務事件:完成購買
 */
export const trackPurchase = (order) => {
  trackEvent('purchase', {
    transaction_id: order.orderId,
    currency: 'TWD',
    value: order.total,
    items: [
      {
        item_id: order.courseId,
        item_name: order.courseName,
        item_category: order.category,
        item_variant: order.variant === 'group' ? '小班制' : '一對一',
        price: order.total,
      },
    ],
  });
};

/**
 * 用戶註冊事件
 */
export const trackSignUp = (method = 'email') => {
  trackEvent('sign_up', {
    method,
  });
};

/**
 * 用戶登入事件
 */
export const trackLogin = (method = 'email') => {
  trackEvent('login', {
    method,
  });
};

/**
 * 聯絡表單提交
 */
export const trackContactFormSubmit = (subject) => {
  trackEvent('contact_form_submit', {
    form_subject: subject,
  });
};
