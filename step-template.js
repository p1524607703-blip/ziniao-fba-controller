(() => {
  const CONFIG = __CONFIG__;

  const normalize = value => String(value || "").replace(/\s+/g, "").trim();
  const visibleText = value => String(value || "").trim().slice(0, 1800);

  if (
    location.protocol === "chrome-error:" ||
    location.href.includes("/error.html")
  ) {
    return JSON.stringify({
      status: "TECHNICAL_ERROR",
      sku: CONFIG.sku,
      message: "浏览器处于网络错误页，禁止快速重试"
    });
  }

  const host = document.querySelector("spl-workflow");
  const frame = host?.shadowRoot?.querySelector("iframe");
  const doc = frame?.contentDocument;

  if (!doc?.body) {
    return JSON.stringify({
      status: "WAIT_WORKFLOW",
      message: "FBA 工作流 iframe 尚未加载"
    });
  }

  const bodyText = doc.body.innerText || "";
  const buttons = [...doc.querySelectorAll("button")];
  const exactButton = text =>
    buttons.find(button => normalize(button.innerText || button.textContent) === normalize(text));

  const response = (status, extra = {}) => JSON.stringify({
    status,
    sku: CONFIG.sku,
    visibleText: visibleText(bodyText),
    ...extra
  });

  // 最高优先级安全门：本脚本不存在点击“继续”的代码路径。
  if (exactButton("继续")) {
    return response("STOP_BEFORE_CONTINUE", {
      message: "检测到继续按钮，已停止且未点击"
    });
  }

  if (bodyText.includes("已创建问题")) {
    return response("ALREADY_SUBMITTED", {
      message: "页面显示申请已经创建，停止当前 FNSKU"
    });
  }

  if (
    bodyText.includes("technical issues") ||
    bodyText.includes("技术问题") ||
    location.protocol === "chrome-error:"
  ) {
    return response("TECHNICAL_ERROR", {
      message: "页面或网络出现技术错误，禁止快速重试"
    });
  }

  if (bodyText.includes("没有资格") || bodyText.includes("不符合条件")) {
    return response("NOT_ELIGIBLE");
  }

  const nextButton = exactButton("下一页");
  const input = doc.querySelector("#item_input");

  if (input) {
    if (!CONFIG.sku || !/^X[A-Z0-9]{9}$/i.test(CONFIG.sku)) {
      return response("INVALID_FNSKU");
    }

    if (normalize(input.value) !== normalize(CONFIG.sku)) {
      const setter = Object.getOwnPropertyDescriptor(
        doc.defaultView.HTMLInputElement.prototype,
        "value"
      )?.set;

      if (!setter) {
        return response("UNEXPECTED_STATE", {
          message: "无法取得输入框原生 value setter"
        });
      }

      setter.call(input, CONFIG.sku);
      input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
      input.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
      input.dispatchEvent(new doc.defaultView.Event("blur", { bubbles: true }));
      return response("FNSKU_FILLED");
    }

    if (nextButton && !nextButton.disabled) {
      nextButton.click();
      return response("NEXT_CLICKED", { from: "fnsku" });
    }

    return response("WAIT_NEXT_ENABLED", { from: "fnsku" });
  }

  const radioLabel = radio =>
    (radio.id && doc.querySelector(`label[for="${CSS.escape(radio.id)}"]`)) ||
    radio.closest("label") ||
    radio.parentElement;

  const findRadio = wanted => {
    if (!wanted) return null;
    return [...doc.querySelectorAll('input[type="radio"]')].find(radio =>
      normalize(radioLabel(radio)?.innerText).includes(normalize(wanted))
    ) || null;
  };

  const selectOrAdvance = (wanted, from) => {
    const radio = findRadio(wanted);
    if (!radio) {
      return response("OPTION_NOT_FOUND", { from, wanted });
    }

    if (!radio.checked) {
      radio.click();
      return response("OPTION_SELECTED", { from, wanted });
    }

    if (nextButton && !nextButton.disabled) {
      nextButton.click();
      return response("NEXT_CLICKED", { from });
    }

    return response("WAIT_NEXT_ENABLED", { from });
  };

  if (bodyText.includes("选择您遇到的问题")) {
    return selectOrAdvance(CONFIG.issueText, "issue");
  }

  if (bodyText.includes("您是否有自己商品的重量和尺寸数据")) {
    if (CONFIG.ownDataAnswer !== "否") {
      return response("NEED_OWN_DATA_DECISION", {
        message: "当前安全流程只自动选择'否'"
      });
    }

    const noButton = exactButton("否");
    if (!noButton) {
      return response("UNEXPECTED_STATE", {
        message: "未找到'否'按钮"
      });
    }

    noButton.click();
    return response("OWN_DATA_NO_SELECTED");
  }

  if (
    bodyText.includes("Reason for measurement request") ||
    bodyText.includes("选择需要更新商品测量值的最准确原因")
  ) {
    if (!CONFIG.reasonText) {
      return response("NEED_REASON");
    }
    return selectOrAdvance(CONFIG.reasonText, "reason");
  }

  if (bodyText.includes("选择以下最准确的包装选项")) {
    if (!CONFIG.packageText) {
      return response("NEED_PACKAGE_TYPE");
    }
    return selectOrAdvance(CONFIG.packageText, "package");
  }

  // 页面内容几乎为空 → 多半是向导仍在加载，归为可重试的等待态(而非硬失败)
  if (bodyText.trim().length < 40) {
    return response("WAIT_WORKFLOW", {
      message: "页面内容几乎为空，可能仍在加载"
    });
  }

  return response("UNEXPECTED_STATE", {
    message: "页面结构与已知 FBA 重测流程不一致"
  });
})()