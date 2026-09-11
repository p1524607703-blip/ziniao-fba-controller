(() => {
  const CONFIG = __CONFIG__;

  const normalize = value => String(value || "").replace(/\s+/g, "").trim();
  // 上限放宽到 8000：尺寸/重量信息常排在页面文本靠后位置，原先 1800 会把它切掉导致采集为空
  const visibleText = value => String(value || "").trim().slice(0, 8000);

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

  // 读取工作流元数据：亚马逊把"当前步骤名/类型/工作流状态"写在 data-step-attr 上。
  // 这比文案匹配可靠得多——文案会随版本改，步骤名稳定。
  let stepName = "";
  let stepType = "";
  try {
    const stepEl = doc.querySelector("[data-step-attr]");
    const meta = JSON.parse((stepEl && stepEl.getAttribute("data-step-attr")) || "{}");
    stepName = String(meta.currentStepName || "");
    stepType = String(meta.currentStepType || "");
  } catch (e) {}

  // 终态页通常都会写"FNSKU 的详细信息： XXXXXXXXXX"。
  // 若页面显示的 FNSKU 与当前要处理的不一致，说明这是上一条 SKU 遗留的陈旧残留页，
  // 绝不能据此判定本条 SKU 的结论（这是"整段 SKU 被误判"的根源）。
  const shownFnsku = (bodyText.match(/FNSKU\s*的详细信息[：:]\s*([A-Z0-9]{10})/i) || [])[1] || "";
  const staleResponse = () => response("STALE_PAGE", {
    message: `页面残留在 ${shownFnsku}，与当前 ${CONFIG.sku} 不一致（陈旧页，需重载）`,
    shown: shownFnsku
  });
  const pageIsStale = !!shownFnsku && normalize(shownFnsku) !== normalize(CONFIG.sku);

  // 终态：亚马逊判定"不符合重新测量资格"。该页没有任何按钮，只展示 FNSKU 当前尺寸。
  // 旧版仅靠文案(没有资格/不符合条件)判断会漏判 → 误报"页面结构不一致"，把 SKU 标成结构异常。
  if (stepName.includes("inform_seller_not_eligible_for_re_measurement")) {
    if (pageIsStale) return staleResponse();
    return response("NOT_ELIGIBLE", {
      message: "亚马逊判定该 FNSKU 不符合重新测量资格（终态页，无可用按钮）",
      step: stepName
    });
  }

  // 最高优先级安全门：默认绝不点击“继续”（硬停）。
  // 仅当服务端显式下发 allowSubmit=true（用户已解封）才点击，并返回 CONTINUE_CLICKED 交服务端回读确认。
  const continueButton = exactButton("继续");
  if (continueButton) {
    if (!CONFIG.allowSubmit) {
      return response("STOP_BEFORE_CONTINUE", {
        message: "检测到继续按钮，已停止且未点击（未解封）"
      });
    }

    const btnInfo = {
      text: normalize(continueButton.innerText || continueButton.textContent),
      id: continueButton.id || "",
      cls: String(continueButton.className || "").slice(0, 80),
      type: continueButton.type || ""
    };
    continueButton.click();
    return response("CONTINUE_CLICKED", {
      message: "已自动点击继续（已解封），等待服务端回读确认",
      btn: btnInfo
    });
  }

  if (bodyText.includes("已创建问题")) {
    return response("ALREADY_SUBMITTED", {
      message: "页面显示申请已经创建，停止当前 FNSKU"
    });
  }

  // 无库存页：亚马逊明确拒绝重测（库存低/留作配送/转运中），无需重试，秒判
  if (bodyText.includes("没有可测量的库存") || /无法.{0,12}执行重新测量/.test(bodyText)) {
    if (pageIsStale) return staleResponse();
    return response("NO_INVENTORY", {
      message: "无可测量库存，亚马逊拒绝重测（待补货后才能重测）"
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