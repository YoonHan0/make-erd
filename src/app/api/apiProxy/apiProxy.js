/**
 * Amaranth 10 API를 호출하는 프론트엔드 통합 함수
 * 
 * @param {string} method - HTTP 메서드 ("GET", "POST" 등)
 * @param {string} domain - 도메인 (예: "https://api.amaranth10.co.kr")
 * @param {string} urlPath - API 경로 (예: "/api/test/v1") - GET 파라미터 제외!
 * @param {string|null} parameters - POST면 JSON string body, GET이면 쿼리스트링
 * @param {string} token - 로그인 시 발급받은 auth_a_token
 * @param {string} hashKey - 로그인 시 발급받은 hash_key (signKey)
 * @param {string|null} callerName - 호출자명
 * @param {string|null} groupSeq - 그룹시퀀스
 * @returns {Promise<any>} API 응답 데이터 -원복완료-
 */
export async function invokeAmaranthApi(
    method, 
    domain, 
    urlPath, 
    parameters, 
    token, 
    hashKey, 
    callerName, 
    groupSeq
) {
    method = method.toUpperCase();

    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.getRandomValues || !cryptoApi?.subtle) {
        throw new Error('Crypto API를 사용할 수 없는 환경입니다.');
    }

    // 1. Transaction ID 생성 (32자리 랜덤 16진수)
    // 보안적으로 안전한 crypto.getRandomValues 사용
    const randomArray = new Uint8Array(16);
    cryptoApi.getRandomValues(randomArray);
    const transactionId = Array.from(randomArray, byte => byte.toString(16).padStart(2, '0'))
                               .join('')
                               .toUpperCase();

    // 2. Timestamp 생성 (초 단위)
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // 3. 서명(wehago-sign) 대상 문자열 조합 (파라미터가 빠진 순수 경로 사용)
    const signTargetData = token + transactionId + timestamp + urlPath;

    // 4. Web Crypto API를 이용한 HMAC-SHA256 해시 생성 및 Base64 인코딩
    const encoder = new TextEncoder();
    
    // 서명키 생성
    const cryptoKey = await cryptoApi.subtle.importKey(
        'raw', 
        encoder.encode(hashKey), 
        { name: 'HMAC', hash: 'SHA-256' }, 
        false, 
        ['sign']
    );
    
    // 서명(해시) 수행
    const signatureBuffer = await cryptoApi.subtle.sign(
        'HMAC', 
        cryptoKey, 
        encoder.encode(signTargetData)
    );
    
    // ArrayBuffer를 Base64 문자열로 변환
    const signatureBytes = new Uint8Array(signatureBuffer);
    const wehagoSign =
        typeof Buffer !== 'undefined'
            ? Buffer.from(signatureBytes).toString('base64')
            : btoa(String.fromCharCode.apply(null, signatureBytes));

    // 5. URL 조립 (GET 방식일 경우 쿼리스트링 추가)
    let requestUrlStr = domain + (domain.endsWith('/') || urlPath.startsWith('/') ? '' : '/') + urlPath;
    if (method === 'GET' && parameters) {
        requestUrlStr += '?' + parameters;
    }

    // 6. Request Header 세팅
    const headers = new Headers({
        'Content-Type': 'application/json',
        'transaction-id': transactionId,
        'Authorization': `Bearer ${token}`,
        'wehago-sign': wehagoSign,
        'timestamp': timestamp
    });

    if (callerName) {
        headers.append('callerName', callerName);
        if (groupSeq) headers.append('groupSeq', groupSeq);
    }

    // 7. Fetch API 옵션 세팅
    const fetchOptions = {
        method: method,
        headers: headers
    };

    if (method === 'POST' && parameters) {
        fetchOptions.body = parameters; // parameters는 보통 JSON.stringify() 된 문자열
    }

    // 8. API 호출 및 응답 처리
    try {
        const response = await fetch(requestUrlStr, fetchOptions);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP Status ${response.status} Error: ${errorText}`);
        }

        // 서버 응답이 JSON 포맷이라고 가정 (필요시 response.text()로 변경)
        const responseData = await response.json();
        return responseData;

    } catch (error) {
        console.error('API Invocation Failed:', error);
        throw error;
    }
}

export default invokeAmaranthApi;