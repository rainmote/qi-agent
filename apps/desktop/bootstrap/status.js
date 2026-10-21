const status = new URLSearchParams(location.search).get("status");
if (status) document.getElementById("status").textContent = status;
